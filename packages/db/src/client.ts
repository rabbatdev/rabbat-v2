import type { DbPage, DbWrite, PaginationOpts, QuerySpec, Row, Scalar } from "@rabbat/protocol"
import type { DataModel } from "@rabbat/schema"
import { type DbExecutor, type Paginated, QueryBuilder } from "@rabbat/functions"
import type { DbTransport } from "./transport.js"

/** A staged, atomic write batch (see {@link RabbatDb.tx}). */
export interface DbTx<DM extends DataModel> {
  /** Read committed state (does NOT see this tx's own un-flushed writes). */
  table<T extends keyof DM & string>(name: T): QueryBuilder<DM[T]["row"]>
  get<T extends keyof DM & string>(name: T, id: Scalar): Promise<DM[T]["row"] | null>
  insert<T extends keyof DM & string>(name: T, value: DM[T]["insert"]): void
  patch<T extends keyof DM & string>(name: T, id: Scalar, fields: DM[T]["patch"]): void
  delete<T extends keyof DM & string>(name: T, id: Scalar): void
}

/**
 * A flexible, server-only database client for Rabbat.
 *
 * Unlike the `ctx.db` handed to a function, this is usable **outside** any
 * function context — from an auth adapter, a script, a cron, another Worker —
 * with no reactive subscription machinery. Reads and writes are plain promises;
 * you interleave them freely instead of buffering into one function commit.
 *
 * Every write still flows through the partition's single-writer commit path, so
 * it is durable, ordered, engine-validated (column kinds, uniqueness, size
 * caps), AND fans out to live `useQuery` subscribers — an external `insert`
 * updates the UI just like a mutation would.
 *
 * SECURITY: this speaks the privileged admin protocol authenticated by a service
 * key. Keep it server-side; never ship the key or this client to a browser.
 */
export interface RabbatDb<DM extends DataModel = DataModel> {
  /** Start a typed query over a table (reads: collect/take/first/paginate). */
  table<T extends keyof DM & string>(name: T): QueryBuilder<DM[T]["row"]>
  /** Fetch one row by primary key. */
  get<T extends keyof DM & string>(name: T, id: Scalar): Promise<DM[T]["row"] | null>
  /** Insert a row (one atomic commit). */
  insert<T extends keyof DM & string>(name: T, value: DM[T]["insert"]): Promise<void>
  /** Patch a row by primary key (one atomic commit). */
  patch<T extends keyof DM & string>(name: T, id: Scalar, fields: DM[T]["patch"]): Promise<void>
  /** Delete a row by primary key (one atomic commit). */
  delete<T extends keyof DM & string>(name: T, id: Scalar): Promise<void>
  /**
   * Apply several writes as ONE atomic commit. Either all land or none do (a
   * validation/uniqueness failure rolls back the batch).
   */
  tx<R>(fn: (tx: DbTx<DM>) => Promise<R> | R): Promise<R>
  /** Low-level: apply a raw write batch atomically. */
  mutate(writes: ReadonlyArray<DbWrite>): Promise<{ lsn: number; changes: number }>
}

/** A read-only executor backed by the admin transport (drives QueryBuilder). */
function readExecutor(transport: DbTransport): DbExecutor {
  const noWrite = () => Promise.reject(new Error("use db.insert/patch/delete or db.tx() to write"))
  return {
    collect: (spec: QuerySpec, limit: number) => transport.call({ op: "query", spec, limit }) as Promise<Row[]>,
    paginate: async (spec: QuerySpec, opts: PaginationOpts) => {
      const page = (await transport.call({ op: "paginate", spec, opts })) as DbPage
      const result: Paginated<Row> = {
        __paginated: true,
        page: page.rows,
        total: page.total,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        pk: page.pk,
      }
      return result
    },
    get: (table: string, id: Scalar) => transport.call({ op: "get", table, pk: id }) as Promise<Row | null>,
    insert: noWrite,
    patch: noWrite,
    remove: noWrite,
  }
}

/**
 * Build a {@link RabbatDb} over a transport. Pair with `bindingTransport`
 * (in-Worker, most secure) or `httpTransport` (server-to-server).
 *
 * ```ts
 * const db = createRabbatDb<DataModel>(bindingTransport({
 *   namespace: env.RABBAT_PARTITION,
 *   serviceKey: env.RABBAT_SERVICE_KEY,
 * }))
 * const user = await db.table("users").where("email", "=", email).first()
 * await db.insert("sessions", { id, userId: user.id, expiresAt })
 * ```
 */
export function createRabbatDb<DM extends DataModel = DataModel>(transport: DbTransport): RabbatDb<DM> {
  // Server-only guard: `window` exists in browsers but not in workerd or Node.
  // This turns an accidental browser bundling into a loud runtime error (the
  // service key must never reach a browser) rather than a silent security hole.
  if (typeof window !== "undefined" && typeof (window as { document?: unknown }).document !== "undefined") {
    throw new Error(
      "@rabbat/db is server-only and must not run in a browser — it speaks a privileged, service-key-authenticated protocol. Use @rabbat/react on the client.",
    )
  }
  const reads = readExecutor(transport)
  const table = <T extends keyof DM & string>(name: T) =>
    new QueryBuilder<DM[T]["row"]>(reads, name)
  const get = <T extends keyof DM & string>(name: T, id: Scalar) =>
    reads.get(name, id) as Promise<DM[T]["row"] | null>

  const mutate = async (writes: ReadonlyArray<DbWrite>) =>
    (await transport.call({ op: "mutate", writes })) as { lsn: number; changes: number }

  return {
    table,
    get,
    insert: async (name, value) => {
      await mutate([{ kind: "insert", table: name, row: value as Row }])
    },
    patch: async (name, id, fields) => {
      await mutate([{ kind: "patch", table: name, pk: id, fields: fields as Record<string, Scalar> }])
    },
    delete: async (name, id) => {
      await mutate([{ kind: "delete", table: name, pk: id }])
    },
    mutate,
    tx: async (fn) => {
      const writes: DbWrite[] = []
      const tx: DbTx<DM> = {
        table,
        get,
        insert: (name, value) => void writes.push({ kind: "insert", table: name, row: value as Row }),
        patch: (name, id, fields) =>
          void writes.push({ kind: "patch", table: name, pk: id, fields: fields as Record<string, Scalar> }),
        delete: (name, id) => void writes.push({ kind: "delete", table: name, pk: id }),
      }
      const result = await fn(tx)
      if (writes.length > 0) await mutate(writes)
      return result
    },
  }
}
