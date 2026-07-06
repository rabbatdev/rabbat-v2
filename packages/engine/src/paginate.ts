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
import { QueryError, type StorageError } from "./errors.js"
import { encodeKey, prefixUpperBound } from "./keys.js"
import { LsmStore } from "./lsm/store.js"
import { PRIMARY, keyspaceId } from "./lsm/types.js"
import {
  type Filter,
  type QuerySpec,
  chooseIndex,
  compileMatcher,
  effectiveOrder,
  matchesRow,
} from "./query.js"

/** Decode a client cursor as a typed failure (never a fiber defect). */
const decodeCursorE = (cursor: string, arity: number): Effect.Effect<Scalar[], QueryError> =>
  Effect.try({
    try: () => decodeCursor(cursor, arity).key,
    catch: (e) => new QueryError({ message: e instanceof Error ? e.message : "bad cursor" }),
  })

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
): Effect.Effect<WindowResult, StorageError | QueryError, LsmStore> =>
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
    const matches = compileMatcher(residual)

    const anchorPhys = yield* resolveAnchorKey(opts.anchor, table, spec, order, plan.eqPrefix, store)

    /**
     * Scan one side, retrying with a growing cap until we have `n+1` rows that
     * survive the residual filter (so `more` is accurate) or the underlying scan
     * is exhausted. A fixed over-fetch factor silently truncated sparse residual
     * results and reported `hasMore=false`, terminating infinite scroll early.
     */
    const scanSide = (
      lo: Uint8Array,
      hi: Uint8Array | null,
      desc: boolean,
      n: number,
    ): Effect.Effect<{ rows: Row[]; more: boolean }, StorageError, LsmStore> =>
      Effect.gen(function* () {
        if (n <= 0) return { rows: [], more: false }
        const want = n + 1
        let cap = residual.length > 0 ? want * 4 : want
        for (let attempt = 0; attempt < 24; attempt++) {
          const entries = yield* store.scan(plan.keyspace, lo, hi, desc, cap)
          const rows = pluck(entries, matches)
          if (rows.length >= want || entries.length < cap) {
            // Either enough post-filter rows, or the scan itself was exhausted
            // (fewer entries than the cap → no more rows exist in range).
            return { rows: rows.slice(0, n), more: rows.length > n }
          }
          cap *= 4
        }
        // Give up growing: return what we have and signal there may be more.
        const rows = pluck(yield* store.scan(plan.keyspace, lo, hi, desc, cap), matches)
        return { rows: rows.slice(0, n), more: rows.length > n }
      })

    // ── after-or-at: rows at/after the anchor in effective order ──────────────
    const afterAt = (n: number): Effect.Effect<{ rows: Row[]; more: boolean }, StorageError, LsmStore> => {
      if (!reverse) return scanSide(anchorPhys ?? groupLo, groupHi, false, n)
      return scanSide(groupLo, anchorPhys ? successor(anchorPhys) : groupHi, true, n)
    }

    // ── strictly before: rows before the anchor in effective order ────────────
    const beforeStrict = (n: number): Effect.Effect<{ rows: Row[]; more: boolean }, StorageError, LsmStore> =>
      Effect.gen(function* () {
        const side = !reverse
          ? yield* scanSide(groupLo, anchorPhys ?? groupHi, true, n)
          : yield* scanSide(anchorPhys ? successor(anchorPhys) : groupLo, groupHi, false, n)
        // `side.rows` is nearest-to-anchor first; reverse into effective order.
        return { rows: side.rows.slice().reverse(), more: side.more }
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
    const total = yield* countGroup(plan.keyspace, groupLo, groupHi, matches, store)
    return { rows, hasOlder, hasNewer, total }
  })

function pluck(entries: ReadonlyArray<{ row: Row | null }>, matches: (row: Row) => boolean): Row[] {
  const out: Row[] = []
  for (const e of entries) {
    if (e.row === null) continue
    if (!matches(e.row)) continue
    out.push(e.row)
  }
  return out
}

const countGroup = (
  keyspace: string,
  lo: Uint8Array,
  hi: Uint8Array | null,
  matches: (row: Row) => boolean,
  store: LsmStore["Service"],
): Effect.Effect<number, StorageError> =>
  store.scan(keyspace, lo, hi, false, TOTAL_SCAN_CAP).pipe(
    Effect.map((entries) => pluck(entries, matches).length),
  )

/** Resolve an anchor to the physical keyspace key it sits at, or null for an edge. */
const resolveAnchorKey = (
  anchor: Anchor,
  table: TableInfo,
  spec: QuerySpec,
  order: ReadonlyArray<OrderKey>,
  eqPrefix: ReadonlyArray<Scalar>,
  store: LsmStore["Service"],
): Effect.Effect<Uint8Array | null, StorageError | QueryError> =>
  Effect.gen(function* () {
    switch (anchor.kind) {
      case "latest":
      case "earliest":
        return null
      case "cursor": {
        // The cursor's key tuple must have exactly one element per order column;
        // a forged/transplanted cursor of the wrong arity or with non-scalar
        // elements is rejected here rather than corrupting the seek.
        const key = yield* decodeCursorE(anchor.cursor, order.length)
        return encodeKey([...eqPrefix, ...key])
      }
      case "key": {
        const hit = yield* store.getByKey(keyspaceId(table.name, PRIMARY), encodeKey([anchor.key]))
        if (!hit || hit.row === null) return null // deleted row → fall back to edge
        // Jump-to-key only makes sense for a row inside this query's group. A row
        // outside the filters would splice an arbitrary order-suffix onto the
        // group prefix and land the window at a nonsense position — fall back to
        // the edge instead.
        if (!matchesRow(hit.row, spec.filters)) return null
        const suffix = keyOf(hit.row, order)
        return encodeKey([...eqPrefix, ...suffix])
      }
    }
  })

/**
 * Unindexed fallback: scan the whole primary keyspace, filter, sort in memory,
 * then window. O(table) — correct but only suitable for small tables / dev.
 * `strictIndexes` (production) rejects these outright; otherwise a scan that hits
 * the cap fails loudly rather than silently returning a truncated result set.
 */
const fallbackWindow = (
  table: TableInfo,
  spec: QuerySpec,
  opts: PaginationOpts,
  order: ReadonlyArray<OrderKey>,
): Effect.Effect<WindowResult, StorageError | QueryError, LsmStore> =>
  Effect.gen(function* () {
    if (table.strictIndexes) {
      return yield* Effect.fail(
        new QueryError({
          message: `query on "${table.name}" is not served by any index (add an index for its filters/order; unindexed scans are disabled in production)`,
        }),
      )
    }
    const store = yield* LsmStore
    const matches = compileMatcher(spec.filters)
    const entries = yield* store.scan(
      keyspaceId(table.name, PRIMARY),
      new Uint8Array(0),
      null,
      false,
      FALLBACK_SCAN_CAP + 1,
    )
    if (entries.length > FALLBACK_SCAN_CAP) {
      return yield* Effect.fail(
        new QueryError({
          message: `unindexed scan of "${table.name}" exceeds ${FALLBACK_SCAN_CAP} rows — add an index for this query`,
        }),
      )
    }
    const all = entries.map((e) => e.row).filter((r): r is Row => r !== null && matches(r))
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
        const key = yield* decodeCursorE(anchor.cursor, order.length)
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
