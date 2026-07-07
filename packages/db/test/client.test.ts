import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import type { DbRequest, DbPage } from "@rabbat/protocol"
import { compileSchema, defineSchema, defineTable, s, type DataModelOf } from "@rabbat/schema"
import { Engine, EngineLive, LsmStoreLive, MemoryBlobStore, type RowChange } from "@rabbat/engine"
import { createRabbatDb, type DbTransport, RabbatDbError } from "../src/index.js"

// A schema an auth adapter might use.
const schema = defineSchema({
  users: defineTable(
    { id: s.text().primaryKey(), email: s.text().unique(), name: s.text(), age: s.int() },
    { indexes: [{ name: "by_email", columns: ["email"] }] },
  ),
  sessions: defineTable(
    { id: s.text().primaryKey(), userId: s.text(), expiresAt: s.int() },
    { indexes: [{ name: "by_user", columns: ["userId"] }] },
  ),
})
type DM = DataModelOf<typeof schema>
const info = compileSchema(schema)

/**
 * A transport that runs the admin protocol against a real in-memory engine —
 * exactly what the partition `/db` endpoint does — so this exercises the full
 * client → protocol → engine path. It also records committed RowChanges (what
 * the reactive engine fans out) so we can assert external writes are reactive.
 */
function engineTransport(): { transport: DbTransport; changes: RowChange[] } {
  const layer = EngineLive(info).pipe(
    Layer.provide(LsmStoreLive({ prefix: "db-test" })),
    Layer.provide(MemoryBlobStore()),
  )
  const engine = Effect.runSync(Effect.provide(Engine, layer) as Effect.Effect<Engine["Service"], never, never>)
  const changes: RowChange[] = []
  // Mirror the partition `/db` endpoint: dispatch against the engine, and on an
  // engine failure surface it exactly as the real transport does — a thrown
  // RabbatDbError (partition catches → `{ok:false,error}` → transport.unwrap).
  const dispatch = async (req: DbRequest): Promise<unknown> => {
    switch (req.op) {
      case "get":
        return Effect.runPromise(engine.get(req.table, req.pk))
      case "query":
        // Mirror the endpoint's clampLimit (cap at COLLECT_LIMIT + 1 so the
        // over-fetch sentinel survives and collect()'s loud guard still fires).
        return Effect.runPromise(engine.collect(req.spec, Math.min(req.limit, 4097)))
      case "paginate": {
        const out = await Effect.runPromise(engine.paginate(req.spec, req.opts))
        const page: DbPage = {
          rows: out.rows,
          pk: out.pk,
          order: out.order,
          hasOlder: out.hasOlder,
          hasNewer: out.hasNewer,
          total: out.total,
        }
        return page
      }
      case "mutate": {
        const res = await Effect.runPromise(engine.mutate(req.writes.map((w) => ({ ...w }) as never)))
        changes.push(...res.changes)
        return { lsn: res.lsn, changes: res.changes.length }
      }
    }
  }
  const transport: DbTransport = {
    call: (req) =>
      dispatch(req).catch((e) => {
        throw new RabbatDbError(e instanceof Error ? e.message : String(e), 400)
      }),
  }
  return { transport, changes }
}

describe("@rabbat/db client", () => {
  it("inserts, gets, and queries outside any function context", async () => {
    const { transport } = engineTransport()
    const db = createRabbatDb<DM>(transport)

    await db.insert("users", { id: "u1", email: "a@x.com", name: "Ada", age: 30 })
    const byId = await db.get("users", "u1")
    expect(byId?.name).toBe("Ada")

    const byEmail = await db.table("users").where("email", "=", "a@x.com").first()
    expect(byEmail?.id).toBe("u1")

    await db.insert("users", { id: "u2", email: "b@x.com", name: "Bo", age: 25 })
    const all = await db.table("users").order("age", "asc").collect()
    expect(all.map((u) => u.id)).toEqual(["u2", "u1"])
  })

  it("patches and deletes by primary key", async () => {
    const { transport } = engineTransport()
    const db = createRabbatDb<DM>(transport)
    await db.insert("users", { id: "u1", email: "a@x.com", name: "Ada", age: 30 })
    await db.patch("users", "u1", { name: "Ada L." })
    expect((await db.get("users", "u1"))?.name).toBe("Ada L.")
    await db.delete("users", "u1")
    expect(await db.get("users", "u1")).toBeNull()
  })

  it("tx() commits multiple writes atomically", async () => {
    const { transport, changes } = engineTransport()
    const db = createRabbatDb<DM>(transport)
    await db.insert("users", { id: "u1", email: "a@x.com", name: "Ada", age: 30 })
    changes.length = 0

    // Create a session and bump the user in one atomic batch.
    await db.tx(async (tx) => {
      const user = await tx.get("users", "u1")
      expect(user?.id).toBe("u1")
      tx.insert("sessions", { id: "s1", userId: "u1", expiresAt: 1000 })
      tx.patch("users", "u1", { age: 31 })
    })
    // One commit → both writes present.
    expect((await db.get("sessions", "s1"))?.userId).toBe("u1")
    expect((await db.get("users", "u1"))?.age).toBe(31)
  })

  it("surfaces engine validation errors (unique, kinds) as RabbatDbError", async () => {
    const { transport } = engineTransport()
    const db = createRabbatDb<DM>(transport)
    await db.insert("users", { id: "u1", email: "dup@x.com", name: "A", age: 1 })
    // Duplicate unique email with a different pk → rejected.
    await expect(
      db.insert("users", { id: "u2", email: "dup@x.com", name: "B", age: 2 }),
    ).rejects.toBeInstanceOf(RabbatDbError)
    // Non-finite / wrong-kind value → rejected by engine validation.
    await expect(
      db.insert("users", { id: "u3", email: "c@x.com", name: "C", age: Infinity as unknown as number }),
    ).rejects.toBeInstanceOf(RabbatDbError)
  })

  it("external writes produce RowChanges (so live subscriptions fan out)", async () => {
    const { transport, changes } = engineTransport()
    const db = createRabbatDb<DM>(transport)
    await db.insert("users", { id: "u1", email: "a@x.com", name: "Ada", age: 30 })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ table: "users", pk: "u1", before: null })
    expect(changes[0]?.after).toMatchObject({ id: "u1", email: "a@x.com" })
  })

  it("paginates like ctx.db", async () => {
    const { transport } = engineTransport()
    const db = createRabbatDb<DM>(transport)
    for (let i = 0; i < 5; i++)
      await db.insert("users", { id: `u${i}`, email: `${i}@x.com`, name: `n${i}`, age: i })
    const page = await db.table("users").order("age", "asc").paginate({
      before: 0,
      after: 3,
      anchor: { kind: "earliest" },
    })
    expect(page.page.map((u) => u.age)).toEqual([0, 1, 2])
    expect(page.hasNewer).toBe(true)
    expect(page.total).toBe(5)
  })
})
