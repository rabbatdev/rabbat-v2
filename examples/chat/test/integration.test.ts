import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Engine, EngineLive, LsmStoreLive, MemoryBlobStore } from "@rabbat/engine"
import { compileSchema } from "@rabbat/schema"
import { ReactiveHub, Runtime, type Outbound } from "@rabbat/server"
import { schema } from "../rabbat/schema.js"
import * as channels from "../rabbat/functions/channels.js"
import * as messages from "../rabbat/functions/messages.js"

/**
 * Exercises the chat example's REAL schema + functions through the same Runtime
 * and ReactiveHub the Durable Object uses, over the R2 LSM engine (in-memory
 * blob store here). `wrangler dev` runs this exact stack on Miniflare against a
 * local R2 bucket.
 */
const makeApp = async () => {
  const schemaInfo = compileSchema(schema)
  const layer = EngineLive(schemaInfo).pipe(
    Layer.provide(LsmStoreLive({ prefix: "chat", flushEntries: 8 })),
    Layer.provide(MemoryBlobStore()),
  )
  const engine = await Effect.runPromise(Effect.provide(Engine, layer))
  const runtime = new Runtime({ schema: schemaInfo, modules: { messages, channels }, auth: (t) => (t ? { subject: t, name: t } : null) }, engine)
  return { runtime, hub: new ReactiveHub(runtime) }
}

const tail = { before: 50, after: 0, anchor: { kind: "latest" as const } }
const pageDeltas = (out: Outbound[]) =>
  out.map((o) => o.message).filter((m): m is Extract<typeof m, { type: "pageDelta" }> => m.type === "pageDelta")

describe("chat example (real schema + functions over the R2 LSM engine)", () => {
  it("sends messages and reads them back as an ordered, paginated window", async () => {
    const { runtime } = await makeApp()
    await runtime.runMutation("channels:create", { name: "general" }, null)
    for (let i = 1; i <= 5; i++) {
      await runtime.runMutation("messages:send", { channelId: "general", author: "ada", body: `m${i}` }, null)
    }
    const res = await runtime.runQuery("messages:list", { channelId: "general", paginationOpts: tail }, null)
    expect(res.paginated).toBe(true)
    // created_at is Date.now(); in a tight loop several share a millisecond and
    // tie-break on the random id, so assert the window's contents, not intra-ms order.
    expect(res.captured!.page.page.map((r) => r.body).sort()).toEqual(["m1", "m2", "m3", "m4", "m5"])
    expect(res.captured!.page.total).toBe(5)
  })

  it("streams an incremental delta to a live subscription when a message is sent", async () => {
    const { runtime, hub } = await makeApp()
    await runtime.runMutation("channels:create", { name: "general" }, null)
    const initial = await hub.subscribe("conn", "s1", "messages:list", { channelId: "general" }, tail, null)
    expect(pageDeltas(initial)[0]!.upserts).toEqual([])

    const commit = await runtime.runMutation("messages:send", { channelId: "general", author: "ada", body: "hello" }, null)
    const out = await hub.onCommit(commit.changes)
    const delta = pageDeltas(out)[0]!
    expect(delta.upserts.map((r) => r.body)).toEqual(["hello"]) // only the new row
    expect(delta.total).toBe(1)
  })

  it("an edit diffs out as a single upsert", async () => {
    const { runtime, hub } = await makeApp()
    await runtime.runMutation("channels:create", { name: "general" }, null)
    const sent = (await runtime.runMutation("messages:send", { channelId: "general", author: "ada", body: "typo" }, null)).value as {
      id: string
    }
    await hub.subscribe("conn", "s1", "messages:list", { channelId: "general" }, tail, null)
    const commit = await runtime.runMutation("messages:edit", { id: sent.id, body: "fixed" }, null)
    const delta = pageDeltas(await hub.onCommit(commit.changes))[0]!
    expect(delta.upserts.map((r) => r.body)).toEqual(["fixed"])
    expect(delta.removes).toEqual([])
  })

  it("the channel list is a reactive value query", async () => {
    const { runtime, hub } = await makeApp()
    const initial = await hub.subscribe("conn", "s1", "channels:list", {}, undefined, null)
    expect((initial.find((o) => o.message.type === "value")!.message as { value: unknown[] }).value).toEqual([])
    const commit = await runtime.runMutation("channels:create", { name: "general" }, null)
    const out = await hub.onCommit(commit.changes)
    const value = (out.find((o) => o.message.type === "value")!.message as { value: { name: string }[] }).value
    expect(value.map((c) => c.name)).toEqual(["general"])
  })
})
