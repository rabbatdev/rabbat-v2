import { Context, Effect, Layer } from "effect"
import type { OrderKey, PaginationOpts, Row, Scalar } from "@rabbat/protocol"
import { type SchemaInfo, type TableInfo, tableInfo } from "@rabbat/schema"
import { QueryError, type StorageError, UniqueViolation } from "./errors.js"
import { encodeKey } from "./keys.js"
import { type DurableState, LsmStore } from "./lsm/store.js"
import { PRIMARY, keyspaceId, type Entry } from "./lsm/types.js"
import { materializeWindow, type WindowResult } from "./paginate.js"
import { effectiveOrder, type QuerySpec } from "./query.js"

/** A row-level mutation. The functions layer's `ctx.db` writers compile to these. */
export type Mutation =
  | { readonly kind: "insert"; readonly table: string; readonly row: Row }
  | { readonly kind: "patch"; readonly table: string; readonly pk: Scalar; readonly fields: Partial<Row> }
  | { readonly kind: "delete"; readonly table: string; readonly pk: Scalar }

/** What a committed mutation changed — fed to the reactive engine for routing. */
export interface RowChange {
  readonly table: string
  readonly pk: Scalar
  readonly before: Row | null
  readonly after: Row | null
}

export interface PageOutput extends WindowResult {
  readonly pk: string
  readonly order: ReadonlyArray<OrderKey>
}

export interface EngineApi {
  readonly schema: SchemaInfo
  readonly lsn: () => number
  readonly get: (table: string, pk: Scalar) => Effect.Effect<Row | null, StorageError | QueryError>
  /** Ordered, filtered rows up to `limit` (anchored at the earliest). */
  readonly collect: (spec: QuerySpec, limit: number) => Effect.Effect<Row[], StorageError | QueryError>
  readonly paginate: (
    spec: QuerySpec,
    window: PaginationOpts,
  ) => Effect.Effect<PageOutput, StorageError | QueryError>
  readonly mutate: (
    mutations: ReadonlyArray<Mutation>,
  ) => Effect.Effect<{ lsn: number; changes: RowChange[] }, StorageError | QueryError | UniqueViolation>
  readonly flush: () => Effect.Effect<void, StorageError>
  readonly dump: () => DurableState
  readonly restore: (state: DurableState) => void
}

export class Engine extends Context.Service<Engine, EngineApi>()("rabbat/Engine") {}

/** Strip reserved internal columns before a row leaves the engine. (none yet) */
function publicRow(row: Row): Row {
  return row
}

function indexKey(table: TableInfo, index: string, row: Row): Uint8Array {
  const cols = index === PRIMARY ? [table.pk] : table.indexes.find((i) => i.name === index)!.columns
  return encodeKey(cols.map((c) => row[c] ?? null))
}

export const EngineLive = (schema: SchemaInfo): Layer.Layer<Engine, never, LsmStore> =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const store = yield* LsmStore

      const get = (table: string, pk: Scalar): Effect.Effect<Row | null, StorageError | QueryError> =>
        Effect.gen(function* () {
          const t = requireTable(table)
          const hit = yield* store.getByKey(keyspaceId(t.name, PRIMARY), encodeKey([pk]))
          return hit?.row ? publicRow(hit.row) : null
        })

      const requireTable = (name: string): TableInfo => tableInfo(schema, name)

      const paginate = (spec: QuerySpec, window: PaginationOpts) =>
        Effect.gen(function* () {
          const t = requireTable(spec.table)
          const res = yield* materializeWindow(t, spec, window)
          return { ...res, pk: t.pk, order: effectiveOrder(t, spec) }
        })

      const collect = (spec: QuerySpec, limit: number) =>
        materializeWindow(requireTable(spec.table), spec, {
          before: 0,
          after: limit,
          anchor: { kind: "earliest" },
        }).pipe(Effect.map((r) => r.rows.slice()))

      const mutate = (mutations: ReadonlyArray<Mutation>) =>
        Effect.gen(function* () {
          const batch = new Map<string, Entry[]>()
          const changes: RowChange[] = []
          const push = (ks: string, e: Entry): void => {
            const arr = batch.get(ks) ?? []
            arr.push(e)
            batch.set(ks, arr)
          }

          // Write a row transition into every keyspace, tombstoning any index key
          // that moved. Handles insert (before=null), insert-over-existing pk
          // (before set → old index entries vacated), patch, and delete (after=null).
          const emitWrite = (t: TableInfo, before: Row | null, after: Row | null): void => {
            const pk = (after ?? before)![t.pk]!
            for (const idx of [PRIMARY, ...t.indexes.map((i) => i.name)]) {
              const ks = keyspaceId(t.name, idx)
              const oldKey = before ? indexKey(t, idx, before) : null
              const newKey = after ? indexKey(t, idx, after) : null
              if (oldKey && (!newKey || !bytesEqual(oldKey, newKey))) push(ks, { key: oldKey, pk, row: null })
              if (newKey) push(ks, { key: newKey, pk, row: after })
            }
          }

          for (const m of mutations) {
            const t = requireTable(m.table)
            if (m.kind === "insert") {
              const row = normalizeInsert(t, m.row)
              const before = yield* getRaw(t, row[t.pk]!, store)
              yield* checkUnique(t, row, before, store)
              emitWrite(t, before, row)
              changes.push({ table: t.name, pk: row[t.pk]!, before, after: row })
            } else if (m.kind === "patch") {
              const before = yield* getRaw(t, m.pk, store)
              if (!before) return yield* Effect.fail(new QueryError({ message: `patch: ${t.name}#${m.pk} not found` }))
              const after: Row = { ...before }
              for (const [k, v] of Object.entries(m.fields)) if (v !== undefined) after[k] = v
              after[t.pk] = m.pk
              yield* checkUnique(t, after, before, store)
              emitWrite(t, before, after)
              changes.push({ table: t.name, pk: m.pk, before, after })
            } else {
              const before = yield* getRaw(t, m.pk, store)
              if (!before) continue
              emitWrite(t, before, null)
              changes.push({ table: t.name, pk: m.pk, before, after: null })
            }
          }

          const lsn = yield* store.commit(batch)
          return { lsn, changes }
        })

      // Discharge the LsmStore requirement at the boundary with the resolved store.
      const withStore = <A, E>(eff: Effect.Effect<A, E, LsmStore>): Effect.Effect<A, E> =>
        Effect.provideService(eff, LsmStore, store)

      return {
        schema,
        lsn: () => store.lsn(),
        get: (table, pk) => withStore(get(table, pk)),
        collect: (spec, limit) => withStore(collect(spec, limit)),
        paginate: (spec, window) => withStore(paginate(spec, window)),
        mutate: (mutations) => withStore(mutate(mutations)),
        flush: () => store.flushAll(),
        dump: () => store.dump(),
        restore: (s) => store.restore(s),
      }
    }),
  )

function getRaw(
  table: TableInfo,
  pk: Scalar,
  store: LsmStore["Service"],
): Effect.Effect<Row | null, StorageError> {
  return store.getByKey(keyspaceId(table.name, PRIMARY), encodeKey([pk])).pipe(Effect.map((e) => e?.row ?? null))
}

function checkUnique(
  table: TableInfo,
  row: Row,
  before: Row | null,
  store: LsmStore["Service"],
): Effect.Effect<void, StorageError | UniqueViolation> {
  return Effect.gen(function* () {
    for (const idx of table.indexes) {
      if (!idx.unique) continue
      const key = indexKey(table, idx.name, row)
      if (before && bytesEqual(key, indexKey(table, idx.name, before))) continue
      const hit = yield* store.getByKey(keyspaceId(table.name, idx.name), key)
      if (hit && hit.row !== null && hit.pk !== (row[table.pk] ?? null)) {
        return yield* Effect.fail(new UniqueViolation({ table: table.name, index: idx.name }))
      }
    }
  })
}

function normalizeInsert(table: TableInfo, input: Row): Row {
  const row: Row = {}
  for (const col of table.columns) {
    if (col.name in input) row[col.name] = input[col.name]!
    else if (col.nullable) row[col.name] = null
    else if (col.name === table.pk) throw new Error(`insert into ${table.name}: missing primary key "${col.name}"`)
    else throw new Error(`insert into ${table.name}: missing required column "${col.name}"`)
  }
  return row
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
