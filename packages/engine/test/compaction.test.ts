import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { compileSchema, defineSchema, defineTable, s } from "@rabbat/schema"
import { Engine, EngineLive, LsmStoreLive, MemoryBlobStore } from "@rabbat/engine"

const schema = compileSchema(
  defineSchema({
    kv: defineTable(
      { id: s.text().primaryKey(), v: s.int(), ch: s.text() },
      { indexes: [{ name: "by_ch_v", columns: ["ch", "v"] }] },
    ),
  }),
)
const spec = { table: "kv", filters: [{ column: "ch", op: "=" as const, value: "a" }], order: [{ column: "v", desc: false as const }] }
const layer = EngineLive(schema).pipe(
  Layer.provide(LsmStoreLive({ prefix: "t", flushEntries: 3, compactSegments: 3 })),
  Layer.provide(MemoryBlobStore()),
)
const run = <A, E>(e: Effect.Effect<A, E, Engine>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>)

describe("multi-level compaction newest-wins", () => {
  it("keeps the latest overwrite across many flushes+compactions", async () => {
    const out = await run(Effect.gen(function* () {
      const e = yield* Engine
      // Insert 20 keys, then overwrite each 5 times with increasing v — forces
      // many flushes and multi-level compactions with heavy shadowing.
      for (let k = 0; k < 20; k++)
        yield* e.mutate([{ kind: "insert", table: "kv", row: { id: `k${k}`, v: 0, ch: "a" } }])
      for (let round = 1; round <= 5; round++)
        for (let k = 0; k < 20; k++)
          yield* e.mutate([{ kind: "insert", table: "kv", row: { id: `k${k}`, v: round * 100 + k, ch: "a" } }])
      // Delete half, then re-insert a few, to exercise tombstones through levels.
      for (let k = 0; k < 10; k++) yield* e.mutate([{ kind: "delete", table: "kv", pk: `k${k}` }])
      for (let k = 0; k < 3; k++) yield* e.mutate([{ kind: "insert", table: "kv", row: { id: `k${k}`, v: 9000 + k, ch: "a" } }])
      yield* e.flush()
      const rows = []
      for (let k = 0; k < 20; k++) rows.push(yield* e.get("kv", `k${k}`))
      const page = yield* e.paginate(spec, { before: 0, after: 100, anchor: { kind: "earliest" } })
      return { rows, page }
    }))
    // k0..k2 re-inserted at 9000+, k3..k9 deleted, k10..k19 at round5 (500+k)
    expect(out.rows[0]?.v).toBe(9000)
    expect(out.rows[1]?.v).toBe(9001)
    expect(out.rows[2]?.v).toBe(9002)
    for (let k = 3; k < 10; k++) expect(out.rows[k]).toBeNull()
    for (let k = 10; k < 20; k++) expect(out.rows[k]?.v).toBe(500 + k)
    // Page reflects live rows only: 3 re-inserted + 10 survivors = 13
    expect(out.page.rows.length).toBe(13)
    expect(out.page.total).toBe(13)
    // No duplicate ids in index-ordered read
    const ids = out.page.rows.map((r) => r.id as string)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
