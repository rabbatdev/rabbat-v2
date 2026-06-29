import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Engine, EngineLive, LsmStoreLive, MemoryBlobStore } from "@rabbat/engine"
import { compileSchema, defineSchema, defineTable, s, type DataModelOf } from "@rabbat/schema"
import { defineFunctions, paginationOpts, v } from "@rabbat/functions"
import { ReactiveHub, Runtime, type Outbound } from "@rabbat/server"

// ── A tiny chat-like app, defined the way a user would ──────────────────────
const schema = defineSchema({
  channels: defineTable({
    id: s.text().primaryKey(),
    name: s.text().unique(),
    created_at: s.int().index(),
  }),
  messages: defineTable(
    {
      id: s.text().primaryKey(),
      channel_id: s.text(),
      author: s.text(),
      body: s.text(),
      created_at: s.int(),
    },
    { indexes: [{ name: "by_channel", columns: ["channel_id", "created_at"] }] },
  ),
})
type DM = DataModelOf<typeof schema>
const { query, mutation } = defineFunctions<DM>()

const messages = {
  list: query({
    args: { channelId: v.string(), paginationOpts },
    handler: (ctx, { channelId, paginationOpts }) =>
      ctx.db.table("messages").where("channel_id", "=", channelId).order("created_at", "asc").paginate(paginationOpts),
  }),
  send: mutation({
    args: { channelId: v.string(), body: v.string(), seq: v.number() },
    handler: async (ctx, { channelId, body, seq }) => {
      await ctx.db.insert("messages", { id: `m-${channelId}-${seq}`, channel_id: channelId, author: "t", body, created_at: seq })
    },
  }),
}
const channels = {
  list: query({ args: {}, handler: (ctx) => ctx.db.table("channels").order("created_at", "asc").collect() }),
  create: mutation({
    args: { name: v.string(), at: v.number() },
    handler: async (ctx, { name, at }) => {
      await ctx.db.insert("channels", { id: `c-${name}`, name, created_at: at })
    },
  }),
}

const makeRuntime = async () => {
  const layer = EngineLive(compileSchema(schema)).pipe(
    Layer.provide(LsmStoreLive({ prefix: "test", flushEntries: 4 })),
    Layer.provide(MemoryBlobStore()),
  )
  const engine = await Effect.runPromise(Effect.provide(Engine, layer))
  const runtime = new Runtime({ schema: compileSchema(schema), modules: { messages, channels }, auth: () => null }, engine)
  return { runtime, hub: new ReactiveHub(runtime) }
}

const tail = (n: number) => ({ before: n, after: 0, anchor: { kind: "latest" as const } })
const deltas = (out: Outbound[]) => out.map((o) => o.message).filter((m) => m.type === "pageDelta")
const values = (out: Outbound[]) => out.map((o) => o.message).filter((m) => m.type === "value")

describe("server reactive stack (Runtime + ReactiveHub + Engine)", () => {
  it("a paginated subscription emits an incremental delta on a matching write", async () => {
    const { runtime, hub } = await makeRuntime()
    for (let i = 1; i <= 3; i++) await runtime.runMutation("messages:send", { channelId: "general", body: `m${i}`, seq: i }, null)

    const initial = await hub.subscribe("c1", "s1", "messages:list", { channelId: "general" }, tail(50), null)
    const sub = initial.find((o) => o.message.type === "subscribed")!.message as Extract<typeof initial[number]["message"], { type: "subscribed" }>
    expect(sub.paginated).toBe(true)
    const first = deltas(initial)[0]! as Extract<typeof initial[number]["message"], { type: "pageDelta" }>
    expect(first.upserts.map((r) => r.body)).toEqual(["m1", "m2", "m3"])
    expect(first.total).toBe(3)

    // A new message in the channel → exactly one upsert crosses the wire.
    const commit = await runtime.runMutation("messages:send", { channelId: "general", body: "m4", seq: 4 }, null)
    const out = await hub.onCommit(commit.changes)
    const d = deltas(out)[0]! as Extract<typeof out[number]["message"], { type: "pageDelta" }>
    expect(d.upserts.map((r) => r.body)).toEqual(["m4"])
    expect(d.removes).toEqual([])
    expect(d.total).toBe(4)
  })

  it("routes by channel: a write to another channel never wakes the subscription", async () => {
    const { runtime, hub } = await makeRuntime()
    await runtime.runMutation("messages:send", { channelId: "a", body: "x", seq: 1 }, null)
    await hub.subscribe("c1", "s1", "messages:list", { channelId: "a" }, tail(50), null)

    const commit = await runtime.runMutation("messages:send", { channelId: "b", body: "y", seq: 1 }, null)
    const out = await hub.onCommit(commit.changes)
    expect(out).toEqual([]) // channel "b" write produced no delta for channel "a"
  })

  it("a value (non-paginated) query is reactive and only re-sends on real change", async () => {
    const { runtime, hub } = await makeRuntime()
    const initial = await hub.subscribe("c1", "s1", "channels:list", {}, undefined, null)
    const v0 = values(initial)[0]! as Extract<typeof initial[number]["message"], { type: "value" }>
    expect(v0.value).toEqual([])

    const c1 = await runtime.runMutation("channels:create", { name: "general", at: 1 }, null)
    const out1 = await hub.onCommit(c1.changes)
    const v1 = values(out1)[0]! as Extract<typeof out1[number]["message"], { type: "value" }>
    expect((v1.value as { name: string }[]).map((c) => c.name)).toEqual(["general"])

    // A message write doesn't touch the channels query → no value re-send.
    const m = await runtime.runMutation("messages:send", { channelId: "general", body: "hi", seq: 1 }, null)
    const out2 = await hub.onCommit(m.changes)
    expect(values(out2)).toEqual([])
  })

  it("jump-to-item over the runtime loads a page around a key", async () => {
    const { runtime, hub } = await makeRuntime()
    for (let i = 1; i <= 30; i++) await runtime.runMutation("messages:send", { channelId: "g", body: `n${i}`, seq: i }, null)
    const out = await hub.subscribe(
      "c1",
      "s1",
      "messages:list",
      { channelId: "g" },
      { before: 2, after: 2, anchor: { kind: "key", key: "m-g-15" } },
      null,
    )
    const d = deltas(out)[0]! as Extract<typeof out[number]["message"], { type: "pageDelta" }>
    // before:2 → n13,n14 ; after:2 (at/after the anchor n15) → n15,n16.
    expect(d.upserts.map((r) => r.body)).toEqual(["n13", "n14", "n15", "n16"])
    expect(d.total).toBe(30)
  })
})
