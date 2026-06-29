import { Effect } from "effect"
import {
  type Anchor,
  type OrderKey,
  type PaginationOpts,
  type Row,
  type Scalar,
  compareRows,
  decodeCursor,
  keyOf,
} from "@rabbat/protocol"
import type { TableInfo } from "@rabbat/schema"
import type { StorageError } from "./errors.js"
import { encodeKey, prefixUpperBound } from "./keys.js"
import { LsmStore } from "./lsm/store.js"
import { PRIMARY, keyspaceId } from "./lsm/types.js"
import { type Filter, type QuerySpec, chooseIndex, effectiveOrder, matchesRow } from "./query.js"

/** The maximum rows scanned to compute an exact `total` for a group. */
const TOTAL_SCAN_CAP = 100_000
/** The cap on a full keyspace scan in the unindexed fallback path. */
const FALLBACK_SCAN_CAP = 100_000

export interface WindowResult {
  readonly rows: ReadonlyArray<Row>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly total: number
}

function successor(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1)
  out.set(key, 0)
  out[key.length] = 0x00
  return out
}

/**
 * Materialize a live window of `spec` under `opts`. Uses an index seek when one
 * fits (the common case) and falls back to a filtered full scan + sort
 * otherwise. The window is `{ anchor, before, after }`: `before` rows before the
 * anchor and `after` at/after it, all in effective order. Jump-to-item resolves
 * an anchor row by primary key and loads ~one page around it — never everything
 * in between.
 */
export const materializeWindow = (
  table: TableInfo,
  spec: QuerySpec,
  opts: PaginationOpts,
): Effect.Effect<WindowResult, StorageError, LsmStore> =>
  Effect.gen(function* () {
    const store = yield* LsmStore
    const order = effectiveOrder(table, spec)
    const plan = chooseIndex(table, spec)

    if (!plan) {
      return yield* fallbackWindow(table, spec, opts, order)
    }

    const eqKey = encodeKey(plan.eqPrefix)
    const groupLo = eqKey
    const groupHi = plan.eqPrefix.length > 0 ? prefixUpperBound(eqKey) : null
    const residual = plan.residual
    const reverse = plan.reverse

    // Over-fetch factor to absorb residual-filtered rows.
    const slack = residual.length > 0 ? 4 : 1

    const anchorPhys = yield* resolveAnchorKey(opts.anchor, table, spec, order, plan.eqPrefix, store)

    // ── after-or-at: rows at/after the anchor in effective order ──────────────
    const afterAt = (n: number): Effect.Effect<{ rows: Row[]; more: boolean }, StorageError, LsmStore> =>
      Effect.gen(function* () {
        if (n <= 0) return { rows: [], more: false }
        const want = n + 1
        let raw: Row[]
        if (!reverse) {
          const lo = anchorPhys ?? groupLo
          raw = pluck(yield* store.scan(plan.keyspace, lo, groupHi, false, (want + 0) * slack), residual)
        } else {
          const hi = anchorPhys ? successor(anchorPhys) : groupHi
          raw = pluck(yield* store.scan(plan.keyspace, groupLo, hi, true, want * slack), residual)
        }
        const more = raw.length > n
        return { rows: raw.slice(0, n), more }
      })

    // ── strictly before: rows before the anchor in effective order ────────────
    const beforeStrict = (n: number): Effect.Effect<{ rows: Row[]; more: boolean }, StorageError, LsmStore> =>
      Effect.gen(function* () {
        if (n <= 0) return { rows: [], more: false }
        const want = n + 1
        let raw: Row[]
        if (!reverse) {
          const hi = anchorPhys ?? groupHi
          raw = pluck(yield* store.scan(plan.keyspace, groupLo, hi, true, want * slack), residual)
        } else {
          const lo = anchorPhys ? successor(anchorPhys) : groupLo
          raw = pluck(yield* store.scan(plan.keyspace, lo, groupHi, false, want * slack), residual)
        }
        const more = raw.length > n
        // `raw` is nearest-to-anchor first; reverse into effective order.
        return { rows: raw.slice(0, n).reverse(), more }
      })

    let beforeRows: Row[] = []
    let afterRows: Row[] = []
    let hasOlder = false
    let hasNewer = false

    switch (opts.anchor.kind) {
      case "latest": {
        const b = yield* beforeStrict(opts.before)
        beforeRows = b.rows
        hasOlder = b.more
        hasNewer = false
        break
      }
      case "earliest": {
        const a = yield* afterAt(opts.after)
        afterRows = a.rows
        hasOlder = false
        hasNewer = a.more
        break
      }
      default: {
        const b = yield* beforeStrict(opts.before)
        const a = yield* afterAt(opts.after)
        beforeRows = b.rows
        afterRows = a.rows
        hasOlder = b.more
        hasNewer = a.more
      }
    }

    const rows = [...beforeRows, ...afterRows]
    const total = yield* countGroup(plan.keyspace, groupLo, groupHi, residual, store)
    return { rows, hasOlder, hasNewer, total }
  })

function pluck(entries: ReadonlyArray<{ row: Row | null }>, residual: ReadonlyArray<Filter>): Row[] {
  const out: Row[] = []
  for (const e of entries) {
    if (e.row === null) continue
    if (residual.length > 0 && !matchesRow(e.row, residual)) continue
    out.push(e.row)
  }
  return out
}

const countGroup = (
  keyspace: string,
  lo: Uint8Array,
  hi: Uint8Array | null,
  residual: ReadonlyArray<Filter>,
  store: LsmStore["Service"],
): Effect.Effect<number, StorageError> =>
  store.scan(keyspace, lo, hi, false, TOTAL_SCAN_CAP).pipe(
    Effect.map((entries) => pluck(entries, residual).length),
  )

/** Resolve an anchor to the physical keyspace key it sits at, or null for an edge. */
const resolveAnchorKey = (
  anchor: Anchor,
  table: TableInfo,
  spec: QuerySpec,
  order: ReadonlyArray<OrderKey>,
  eqPrefix: ReadonlyArray<Scalar>,
  store: LsmStore["Service"],
): Effect.Effect<Uint8Array | null, StorageError> =>
  Effect.gen(function* () {
    switch (anchor.kind) {
      case "latest":
      case "earliest":
        return null
      case "cursor":
        return encodeKey([...eqPrefix, ...decodeCursor(anchor.cursor).key])
      case "key": {
        const hit = yield* store.getByKey(keyspaceId(table.name, PRIMARY), encodeKey([anchor.key]))
        if (!hit || hit.row === null) return null // deleted row → fall back to edge
        const suffix = keyOf(hit.row, order)
        return encodeKey([...eqPrefix, ...suffix])
      }
    }
  })

/**
 * Unindexed fallback: scan the whole primary keyspace, filter, sort in memory,
 * then window. O(table) — correct but only suitable for small tables / dev. A
 * production deployment would reject unindexed paginated queries.
 */
const fallbackWindow = (
  table: TableInfo,
  spec: QuerySpec,
  opts: PaginationOpts,
  order: ReadonlyArray<OrderKey>,
): Effect.Effect<WindowResult, StorageError, LsmStore> =>
  Effect.gen(function* () {
    const store = yield* LsmStore
    const entries = yield* store.scan(
      keyspaceId(table.name, PRIMARY),
      new Uint8Array(0),
      null,
      false,
      FALLBACK_SCAN_CAP,
    )
    const all = entries
      .map((e) => e.row)
      .filter((r): r is Row => r !== null && matchesRow(r, spec.filters))
    all.sort((a, b) => compareRows(a, b, order))
    const total = all.length

    const anchor = opts.anchor
    let idx: number
    switch (anchor.kind) {
      case "earliest":
        idx = 0
        break
      case "latest":
        idx = all.length
        break
      case "cursor": {
        const key = decodeCursor(anchor.cursor).key
        idx = all.findIndex((r) => compareRows(r, fromKey(order, key), order) >= 0)
        if (idx < 0) idx = all.length
        break
      }
      case "key": {
        idx = all.findIndex((r) => r[table.pk] === anchor.key)
        if (idx < 0) idx = all.length
        break
      }
    }
    const start = Math.max(0, idx - opts.before)
    const end = Math.min(all.length, idx + opts.after)
    return {
      rows: all.slice(start, end),
      hasOlder: start > 0,
      hasNewer: end < all.length,
      total,
    }
  })

/** Build a synthetic row carrying just the order-key values, for comparison. */
function fromKey(order: ReadonlyArray<OrderKey>, key: ReadonlyArray<Scalar>): Row {
  const r: Row = {}
  order.forEach((o, i) => {
    r[o.column] = key[i] ?? null
  })
  return r
}
