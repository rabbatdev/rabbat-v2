import { Context, Effect, Layer } from "effect"
import type { ColumnKind } from "@rabbat/schema"
import type { OrderKey, PaginationOpts, Row, Scalar } from "@rabbat/protocol"
import { type ColumnInfo, type SchemaInfo, type TableInfo, tableInfo } from "@rabbat/schema"
import { QueryError, type StorageError, UniqueViolation } from "./errors.js"
import { encodeKey, prefixUpperBound } from "./keys.js"
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
  /** Delete compaction-superseded R2 objects; call only after `dump()` is persisted. */
  readonly gc: () => Effect.Effect<void, StorageError>
  /** Mirror the manifest to R2 for disaster recovery. */
  readonly mirrorManifest: () => Effect.Effect<void, StorageError>
  readonly dump: () => DurableState
  readonly restore: (state: DurableState) => void
}

export class Engine extends Context.Service<Engine, EngineApi>()("rabbat/Engine") {}

/** Max serialized size of a single row, and max mutations in one commit. */
const MAX_ROW_BYTES = 512 * 1024
const MAX_BATCH_MUTATIONS = 4096

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

      /** Look up a table as a typed failure (never a fiber defect). */
      const requireTable = (name: string): Effect.Effect<TableInfo, QueryError> => {
        const t = schema.tables.find((t) => t.name === name)
        return t ? Effect.succeed(t) : Effect.fail(new QueryError({ message: `unknown table "${name}"` }))
      }

      const get = (table: string, pk: Scalar): Effect.Effect<Row | null, StorageError | QueryError> =>
        Effect.gen(function* () {
          const t = yield* requireTable(table)
          const hit = yield* store.getByKey(keyspaceId(t.name, PRIMARY), encodeKey([pk]))
          return hit?.row ? publicRow(hit.row) : null
        })

      const paginate = (spec: QuerySpec, window: PaginationOpts) =>
        Effect.gen(function* () {
          const t = yield* requireTable(spec.table)
          const res = yield* materializeWindow(t, spec, window)
          return { ...res, pk: t.pk, order: effectiveOrder(t, spec) }
        })

      const collect = (spec: QuerySpec, limit: number) =>
        Effect.gen(function* () {
          const t = yield* requireTable(spec.table)
          const res = yield* materializeWindow(t, spec, {
            before: 0,
            after: limit,
            anchor: { kind: "earliest" },
          })
          return res.rows.slice()
        })

      const mutate = (mutations: ReadonlyArray<Mutation>) =>
        Effect.gen(function* () {
          if (mutations.length > MAX_BATCH_MUTATIONS) {
            return yield* Effect.fail(
              new QueryError({ message: `mutation batch too large (${mutations.length} > ${MAX_BATCH_MUTATIONS})` }),
            )
          }
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
            const t = yield* requireTable(m.table)
            if (m.kind === "insert") {
              const row = yield* normalizeInsert(t, m.row)
              const before = yield* getRaw(t, row[t.pk]!, store)
              yield* checkUnique(t, row, before, store)
              emitWrite(t, before, row)
              changes.push({ table: t.name, pk: row[t.pk]!, before, after: row })
            } else if (m.kind === "patch") {
              const before = yield* getRaw(t, m.pk, store)
              if (!before) return yield* Effect.fail(new QueryError({ message: `patch: ${t.name}#${m.pk} not found` }))
              // Validate patch fields against the schema: unknown columns are
              // rejected (they would persist as phantom columns and flow to every
              // subscriber), and each value must match its column's kind (a string
              // into an int column would mis-sort the row in every index).
              const after: Row = { ...before }
              for (const [k, val] of Object.entries(m.fields)) {
                if (val === undefined) continue
                if (k === t.pk && !sameScalar(val, m.pk)) {
                  return yield* Effect.fail(
                    new QueryError({ message: `patch ${t.name}#${m.pk}: cannot change primary key` }),
                  )
                }
                const col = t.columns.find((c) => c.name === k)
                if (!col) {
                  return yield* Effect.fail(
                    new QueryError({ message: `patch ${t.name}: unknown column "${k}"` }),
                  )
                }
                const err = checkValue(t, col, val)
                if (err) return yield* Effect.fail(new QueryError({ message: err }))
                after[k] = val
              }
              after[t.pk] = m.pk
              const big = rowTooBig(t, after)
              if (big) return yield* Effect.fail(new QueryError({ message: big }))
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
        gc: () => store.gc(),
        mirrorManifest: () => store.mirrorManifest(),
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
      // Index keys are [uniqueCols…, pk], so the exact key embeds this row's own
      // pk and can never collide with a *different* row. Instead scan the prefix
      // of just the unique columns and fail if any live entry has another pk.
      const uniqueCols = idx.columns.filter((c) => c !== table.pk)
      const prefix = encodeKey(uniqueCols.map((c) => row[c] ?? null))
      if (before) {
        const beforePrefix = encodeKey(uniqueCols.map((c) => before[c] ?? null))
        if (bytesEqual(prefix, beforePrefix)) continue // unique value unchanged
      }
      const hi = prefixUpperBound(prefix)
      const hits = yield* store.scan(keyspaceId(table.name, idx.name), prefix, hi, false, 2)
      const myPk = row[table.pk] ?? null
      if (hits.some((h) => h.row !== null && !sameScalar(h.pk, myPk))) {
        return yield* Effect.fail(new UniqueViolation({ table: table.name, index: idx.name }))
      }
    }
  })
}

/** Validate a column value; returns an error message or null if valid. */
function checkValue(table: TableInfo, col: ColumnInfo, value: Scalar): string | null {
  if (value === null) {
    return col.nullable ? null : `${table.name}.${col.name}: null not allowed`
  }
  const expected = kindType(col.kind)
  if (typeof value !== expected) {
    return `${table.name}.${col.name}: expected ${col.kind} (${expected}), got ${typeof value}`
  }
  if ((col.kind === "int" || col.kind === "float") && !Number.isFinite(value as number)) {
    // Non-finite numbers JSON-serialize to null, silently corrupting order and
    // cursor stability — reject them at the write boundary.
    return `${table.name}.${col.name}: ${col.kind} must be a finite number`
  }
  if (col.kind === "int" && !Number.isInteger(value as number)) {
    return `${table.name}.${col.name}: expected an integer`
  }
  return null
}

function kindType(kind: ColumnKind): "boolean" | "number" | "string" {
  switch (kind) {
    case "bool":
      return "boolean"
    case "int":
    case "float":
      return "number"
    default:
      return "string" // text, bytes (base64)
  }
}

function normalizeInsert(table: TableInfo, input: Row): Effect.Effect<Row, QueryError> {
  const row: Row = {}
  for (const col of table.columns) {
    let value: Scalar
    if (col.name in input) value = input[col.name]!
    else if (col.nullable) value = null
    else if (col.name === table.pk)
      return Effect.fail(new QueryError({ message: `insert into ${table.name}: missing primary key "${col.name}"` }))
    else
      return Effect.fail(new QueryError({ message: `insert into ${table.name}: missing required column "${col.name}"` }))
    const err = checkValue(table, col, value)
    if (err) return Effect.fail(new QueryError({ message: err }))
    row[col.name] = value
  }
  const tooBig = rowTooBig(table, row)
  if (tooBig) return Effect.fail(new QueryError({ message: tooBig }))
  return Effect.succeed(row)
}

/** Reject rows whose serialized size exceeds the per-row cap. */
function rowTooBig(table: TableInfo, row: Row): string | null {
  const bytes = JSON.stringify(row).length
  return bytes > MAX_ROW_BYTES ? `${table.name}: row exceeds ${MAX_ROW_BYTES} bytes` : null
}

function sameScalar(a: Scalar, b: Scalar): boolean {
  return a === b
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
