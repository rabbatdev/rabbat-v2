import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  aroundKey,
  headWindow,
  tailWindow,
  type PaginationOpts,
  type Row,
} from "@rabbat/protocol"
import { compileSchema, defineSchema, defineTable, s } from "@rabbat/schema"
import {
  Engine,
  EngineLive,
  LsmStoreLive,
  MemoryBlobStore,
  Subscription,
  effectiveOrder,
  type QuerySpec,
} from "@rabbat/engine"

const schema = compileSchema(
  defineSchema({
    messages: defineTable(
      {
        id: s.text().primaryKey(),
        channel: s.text(),
        seq: s.int(),
        body: s.text(),
      },
      { indexes: [{ name: "by_channel_seq", columns: ["channel", "seq"] }] },
    ),
  }),
)

const table = schema.tables[0]!

const ascSpec: QuerySpec = {
  table: "messages",
  filters: [{ column: "channel", op: "=", value: "a" }],
  order: [{ column: "seq", desc: false }],
}
const descSpec: QuerySpec = { ...ascSpec, order: [{ column: "seq", desc: true }] }

const pad = (n: number) => String(n).padStart(3, "0")

// Small flush threshold forces real R2 segments + memtable merges during the test.
const layer = (flushEntries = 8) =>
  EngineLive(schema).pipe(
    Layer.provide(LsmStoreLive({ prefix: "test", flushEntries, compactSegments: 4 })),
    Layer.provide(MemoryBlobStore()),
  )

const run = <A, E>(eff: Effect.Effect<A, E, Engine>, flushEntries = 8) =>
  Effect.runPromise(Effect.provide(eff, layer(flushEntries)) as Effect.Effect<A, E, never>)

const seedChannels = (engine: Engine["Service"]) =>
  Effect.gen(function* () {
    for (let seq = 1; seq <= 50; seq++) {
      yield* engine.mutate([
        { kind: "insert", table: "messages", row: { id: `a-${pad(seq)}`, channel: "a", seq, body: `m${seq}` } },
      ])
    }
    for (let seq = 1; seq <= 10; seq++) {
      yield* engine.mutate([
        { kind: "insert", table: "messages", row: { id: `b-${pad(seq)}`, channel: "b", seq, body: `x${seq}` } },
      ])
    }
  })

const seqs = (rows: ReadonlyArray<Row>) => rows.map((r) => r.seq as number)

describe("engine pagination (R2 LSM, memtable + segments)", () => {
  it("ascending tail window with loadOlder semantics", async () => {
    const res = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        const tail = yield* engine.paginate(ascSpec, tailWindow(10))
        const more = yield* engine.paginate(ascSpec, tailWindow(25)) // loadOlder grows `before`
        return { tail, more }
      }),
    )
    expect(seqs(res.tail.rows)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50])
    expect(res.tail.hasOlder).toBe(true)
    expect(res.tail.hasNewer).toBe(false)
    expect(res.tail.total).toBe(50)
    expect(seqs(res.more.rows)).toEqual(Array.from({ length: 25 }, (_, i) => 26 + i))
  })

  it("earliest head window", async () => {
    const head = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        return yield* engine.paginate(ascSpec, headWindow(10))
      }),
    )
    expect(seqs(head.rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(head.hasOlder).toBe(false)
    expect(head.hasNewer).toBe(true)
  })

  it("jump-to-item loads a page around a key, not everything before it", async () => {
    const jump = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        return yield* engine.paginate(ascSpec, aroundKey(`a-${pad(25)}`, 5))
      }),
    )
    // before=5 strictly before seq 25 → 20..24; after=5 at/after → 25..29
    expect(seqs(jump.rows)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
    expect(jump.hasOlder).toBe(true)
    expect(jump.hasNewer).toBe(true)
  })

  it("descending order via reverse seek", async () => {
    const out = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        return yield* engine.collect(descSpec, 5)
      }),
    )
    expect(seqs(out)).toEqual([50, 49, 48, 47, 46])
  })

  it("partition isolation: channel b is untouched by channel a", async () => {
    const out = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        const bSpec: QuerySpec = { ...ascSpec, filters: [{ column: "channel", op: "=", value: "b" }] }
        return yield* engine.paginate(bSpec, tailWindow(100))
      }),
    )
    expect(seqs(out.rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(out.total).toBe(10)
  })
})

describe("mutations", () => {
  it("patch and delete are reflected, with index maintenance", async () => {
    const out = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        yield* engine.mutate([{ kind: "patch", table: "messages", pk: "a-025", fields: { body: "edited" } }])
        yield* engine.mutate([{ kind: "delete", table: "messages", pk: "a-010" }])
        const edited = yield* engine.get("messages", "a-025")
        const gone = yield* engine.get("messages", "a-010")
        const page = yield* engine.paginate(ascSpec, tailWindow(100))
        return { edited, gone, page }
      }),
    )
    expect(res(out.edited).body).toBe("edited")
    expect(out.gone).toBeNull()
    expect(seqs(out.page.rows)).not.toContain(10)
    expect(out.page.total).toBe(49)
  })
})

describe("insert over an existing primary key", () => {
  it("vacates stale secondary-index entries (no duplicates in index-ordered reads)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        // Same pk "dup", different indexed column (seq) → different by_channel_seq key.
        yield* engine.mutate([{ kind: "insert", table: "messages", row: { id: "dup", channel: "a", seq: 1, body: "v1" } }])
        yield* engine.mutate([{ kind: "insert", table: "messages", row: { id: "dup", channel: "a", seq: 2, body: "v2" } }])
        return yield* engine.paginate(ascSpec, tailWindow(100))
      }),
    )
    // The old (seq=1) index entry must be tombstoned: exactly one row, the latest.
    expect(out.rows.map((r) => r.id)).toEqual(["dup"])
    expect(seqs(out.rows)).toEqual([2])
    expect(out.total).toBe(1)
  })
})

describe("incremental view maintenance", () => {
  it("produces upserts/removes diffs, not whole result sets", async () => {
    const out = await run(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* seedChannels(engine)
        const window: PaginationOpts = tailWindow(5)
        const sub = new Subscription(ascSpec, effectiveOrder(table, ascSpec))

        const initial = sub.applyPage(yield* engine.paginate(ascSpec, window))

        // A new message in channel a: should diff to a single upsert + one remove (the row that scrolled off the top of the 5-window).
        const change1 = yield* engine.mutate([
          { kind: "insert", table: "messages", row: { id: "a-051", channel: "a", seq: 51, body: "new" } },
        ])
        const couldChange = sub.windowCanChange(change1.changes)
        const delta1 = sub.applyPage(yield* engine.paginate(ascSpec, window))

        // A message in channel b: routing should reject it (no re-materialize needed).
        const change2 = yield* engine.mutate([
          { kind: "insert", table: "messages", row: { id: "b-099", channel: "b", seq: 99, body: "other" } },
        ])
        const bIgnored = sub.windowCanChange(change2.changes)

        // An edit to an old, off-window message: routing matches but the window can't change.
        const change3 = yield* engine.mutate([
          { kind: "patch", table: "messages", pk: "a-001", fields: { body: "ancient edit" } },
        ])
        const oldIgnored = sub.windowCanChange(change3.changes)

        return { initial, couldChange, delta1, bIgnored, oldIgnored }
      }),
    )
    expect(seqs(out.initial.upserts)).toEqual([46, 47, 48, 49, 50])
    expect(out.initial.removes).toEqual([])

    expect(out.couldChange).toBe(true)
    expect(seqs(out.delta1.upserts)).toEqual([51]) // only the new row is sent
    expect(out.delta1.removes).toEqual(["a-046"]) // the row that left the 5-window
    expect(out.delta1.total).toBe(51)

    expect(out.bIgnored).toBe(false) // channel b never examined channel a's window
    expect(out.oldIgnored).toBe(false) // old off-window edit skipped by the edge check
  })
})

function res(row: Row | null): Row {
  if (!row) throw new Error("expected a row")
  return row
}

// ── Production-hardening regression tests ─────────────────────────────────────

const uniqueSchema = compileSchema(
  defineSchema({
    users: defineTable(
      { id: s.text().primaryKey(), email: s.text().unique(), age: s.int(), handle: s.text().unique().nullable() },
      { indexes: [{ name: "by_org_name", columns: ["email", "age"], unique: true }] },
    ),
  }),
)

const uniqueLayer = () =>
  EngineLive(uniqueSchema).pipe(
    Layer.provide(LsmStoreLive({ prefix: "u", flushEntries: 4 })),
    Layer.provide(MemoryBlobStore()),
  )
const runU = <A, E>(eff: Effect.Effect<A, E, Engine>) =>
  Effect.runPromise(Effect.provide(eff, uniqueLayer()) as Effect.Effect<A, E, never>)

describe("unique constraints", () => {
  it("rejects a second row with a duplicate unique value (different pk)", async () => {
    const err = await runU(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "u1", email: "x@y.com", age: 20 } }])
        return yield* Effect.flip(
          engine.mutate([{ kind: "insert", table: "users", row: { id: "u2", email: "x@y.com", age: 30 } }]),
        )
      }),
    )
    expect((err as { _tag: string })._tag).toBe("UniqueViolation")
  })

  it("allows re-inserting the same pk (upsert) without a false positive", async () => {
    const rows = await runU(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "u1", email: "x@y.com", age: 20, handle: null } }])
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "u1", email: "x@y.com", age: 21, handle: null } }])
        return res(yield* engine.get("users", "u1"))
      }),
    )
    expect(rows.age).toBe(21)
  })

  it("allows many rows to share NULL in a unique column (SQL NULL semantics)", async () => {
    const count = await runU(
      Effect.gen(function* () {
        const engine = yield* Engine
        // `handle` is unique().nullable(); three distinct users all leave it null.
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "a", email: "a@x.com", age: 1, handle: null } }])
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "b", email: "b@x.com", age: 2, handle: null } }])
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "c", email: "c@x.com", age: 3, handle: null } }])
        return (yield* engine.collect({ table: "users", filters: [], order: [] }, 10)).length
      }),
    )
    expect(count).toBe(3)
  })
})

describe("value validation", () => {
  it("rejects non-finite numbers and wrong types at insert", async () => {
    const bad = (row: Row) =>
      runU(
        Effect.gen(function* () {
          const engine = yield* Engine
          return yield* Effect.flip(engine.mutate([{ kind: "insert", table: "users", row }]))
        }),
      )
    expect(((await bad({ id: "a", email: "e", age: Infinity })) as { _tag: string })._tag).toBe("QueryError")
    expect(((await bad({ id: "a", email: "e", age: 1.5 })) as { _tag: string })._tag).toBe("QueryError")
    expect(((await bad({ id: "a", email: 5, age: 1 })) as { _tag: string })._tag).toBe("QueryError")
  })

  it("rejects unknown columns and pk changes in a patch", async () => {
    const bad = await runU(
      Effect.gen(function* () {
        const engine = yield* Engine
        yield* engine.mutate([{ kind: "insert", table: "users", row: { id: "u1", email: "x@y.com", age: 20 } }])
        return yield* Effect.flip(
          engine.mutate([{ kind: "patch", table: "users", pk: "u1", fields: { nope: 1 } as Row }]),
        )
      }),
    )
    expect((bad as { _tag: string })._tag).toBe("QueryError")
  })
})

describe("multi-store isolation (shared bucket)", () => {
  it("two stores under different prefixes never collide", async () => {
    const bucket = MemoryBlobStore()
    const mk = (prefix: string) =>
      EngineLive(schema).pipe(Layer.provide(LsmStoreLive({ prefix, flushEntries: 2 })), Layer.provide(bucket))
    const runP = <A, E>(eff: Effect.Effect<A, E, Engine>, prefix: string) =>
      Effect.runPromise(Effect.provide(eff, mk(prefix)) as Effect.Effect<A, E, never>)

    // Both stores share one MemoryBlobStore but different prefixes; force flushes.
    await runP(
      Effect.gen(function* () {
        const e = yield* Engine
        for (let i = 1; i <= 6; i++)
          yield* e.mutate([{ kind: "insert", table: "messages", row: { id: `p1-${i}`, channel: "a", seq: i, body: "one" } }])
      }),
      "tenant/1",
    )
    const t2 = await runP(
      Effect.gen(function* () {
        const e = yield* Engine
        for (let i = 1; i <= 6; i++)
          yield* e.mutate([{ kind: "insert", table: "messages", row: { id: `p2-${i}`, channel: "a", seq: i, body: "two" } }])
        return yield* e.paginate(ascSpec, tailWindow(100))
      }),
      "tenant/2",
    )
    // Tenant 2 sees only its own rows — no overwrite/leak from tenant 1.
    expect(t2.rows.every((r) => (r.body as string) === "two")).toBe(true)
    expect(t2.rows.map((r) => r.id).sort()).toEqual(["p2-1", "p2-2", "p2-3", "p2-4", "p2-5", "p2-6"])
  })
})
