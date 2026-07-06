import type { Filter, OrderKey, QuerySpec, Row, Scalar } from "@rabbat/protocol"
import { compareScalar } from "@rabbat/protocol"
import type { TableInfo } from "@rabbat/schema"
import { QueryError } from "./errors.js"
import { PRIMARY, keyspaceId } from "./lsm/types.js"

export type { CompareOp, Filter, QuerySpec } from "@rabbat/protocol"

/**
 * The order the engine actually sorts by: the user order plus the primary key as
 * a tiebreaker (so the order is total and cursors are stable). The tiebreaker
 * takes the query's direction when the order is uniformly descending, keeping a
 * single-direction order single-direction so it stays index-seekable.
 */
export function effectiveOrder(table: TableInfo, spec: QuerySpec): OrderKey[] {
  const order = spec.order.map((o) => ({ column: o.column, desc: o.desc }))
  if (!order.some((o) => o.column === table.pk)) {
    const desc = order.length > 0 && order.every((o) => o.desc)
    order.push({ column: table.pk, desc })
  }
  return order
}

/** Cap on a `like` pattern's length — long patterns enable ReDoS backtracking. */
const MAX_LIKE_PATTERN = 256

function likeToRegExp(pattern: string): RegExp {
  if (pattern.length > MAX_LIKE_PATTERN) {
    throw new QueryError({ message: `like pattern too long (max ${MAX_LIKE_PATTERN})` })
  }
  let re = "^"
  for (const ch of pattern) {
    if (ch === "%") re += "[\\s\\S]*"
    else if (ch === "_") re += "[\\s\\S]"
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(re + "$")
}

const isScalar = (v: unknown): v is Scalar =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v))

/**
 * Compile a filter list into a fast row predicate. `like` regexes are built
 * once here (not per row — that was a ReDoS amplifier over a 100k-row scan), and
 * every filter's value type is validated at the trust boundary. Throws
 * `QueryError` on a malformed filter.
 */
export function compileMatcher(filters: ReadonlyArray<Filter>): (row: Row) => boolean {
  const tests: Array<(row: Row) => boolean> = []
  for (const f of filters) {
    if (f.op === "in") {
      if (!Array.isArray(f.value) || !f.value.every(isScalar)) {
        throw new QueryError({ message: `filter ${f.column} in: expected an array of scalars` })
      }
      const set = f.value as ReadonlyArray<Scalar>
      tests.push((row) => set.some((x) => compareScalar(row[f.column] ?? null, x) === 0))
      continue
    }
    if (f.op === "like") {
      if (typeof f.value !== "string") {
        throw new QueryError({ message: `filter ${f.column} like: expected a string pattern` })
      }
      const re = likeToRegExp(f.value)
      tests.push((row) => {
        const v = row[f.column] ?? null
        return typeof v === "string" && re.test(v)
      })
      continue
    }
    if (!isScalar(f.value)) {
      throw new QueryError({ message: `filter ${f.column} ${f.op}: expected a scalar value` })
    }
    const val = f.value as Scalar
    switch (f.op) {
      case "=":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) === 0)
        break
      case "!=":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) !== 0)
        break
      case "<":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) < 0)
        break
      case "<=":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) <= 0)
        break
      case ">":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) > 0)
        break
      case ">=":
        tests.push((row) => compareScalar(row[f.column] ?? null, val) >= 0)
        break
    }
  }
  return (row) => {
    for (const t of tests) if (!t(row)) return false
    return true
  }
}

/** Does a row satisfy every filter (AND semantics)? Compiles per call — prefer
 * {@link compileMatcher} on a hot path. */
export function matchesRow(row: Row, filters: ReadonlyArray<Filter>): boolean {
  return compileMatcher(filters)(row)
}

/**
 * Top-level equality bindings (`col = scalar`). These drive reactive routing: a
 * write is delivered only to subscriptions whose equality prefix it matches, so
 * a write to channel A never examines channel B's subscriptions.
 */
export function equalityBindings(spec: QuerySpec): Array<{ column: string; value: Scalar }> {
  const out: Array<{ column: string; value: Scalar }> = []
  for (const f of spec.filters) {
    if (f.op === "=" && !Array.isArray(f.value)) out.push({ column: f.column, value: f.value as Scalar })
  }
  return out
}

export interface SeekPlan {
  /** The keyspace (`table:index`) whose sorted order serves this query. */
  readonly keyspace: string
  /** Values pinning the index's leading (equality) columns. */
  readonly eqPrefix: Scalar[]
  /** The index columns after the prefix (must equal the effective order). */
  readonly suffixLen: number
  /** Whether the effective order is descending (scan the keyspace backward). */
  readonly reverse: boolean
  /** Filters not consumed by the equality prefix; re-checked per row. */
  readonly residual: ReadonlyArray<Filter>
}

/**
 * Pick an index whose sorted order can serve this query as a *seek* — its
 * leading columns equality-pinned and its trailing columns exactly the effective
 * order. Returns null when nothing fits (the caller falls back to a filtered
 * full keyspace scan + sort). The primary keyspace serves order-by-pk queries.
 */
export function chooseIndex(table: TableInfo, spec: QuerySpec): SeekPlan | null {
  const order = effectiveOrder(table, spec)
  const allAsc = order.every((o) => !o.desc)
  const allDesc = order.every((o) => o.desc)
  if (!allAsc && !allDesc) return null // mixed directions can't seek one keyspace

  const eq = new Map<string, { value: Scalar; index: number }>()
  spec.filters.forEach((f, i) => {
    if (f.op === "=" && !Array.isArray(f.value)) {
      if (!eq.has(f.column)) eq.set(f.column, { value: f.value as Scalar, index: i })
    }
  })

  const orderCols = order.map((o) => o.column)
  // Candidate keyspaces: the declared indexes, plus the implicit primary keyspace.
  const candidates: Array<{ id: string; columns: ReadonlyArray<string> }> = [
    { id: PRIMARY, columns: [table.pk] },
    ...table.indexes.map((idx) => ({ id: idx.name, columns: idx.columns })),
  ]

  for (const cand of candidates) {
    let eqLen = 0
    while (eqLen < cand.columns.length && eq.has(cand.columns[eqLen]!)) eqLen++
    const suffix = cand.columns.slice(eqLen)
    if (suffix.length !== orderCols.length) continue
    if (suffix.some((c, i) => c !== orderCols[i])) continue
    const eqPrefix = cand.columns.slice(0, eqLen).map((c) => eq.get(c)!.value)
    const consumed = new Set(cand.columns.slice(0, eqLen).map((c) => eq.get(c)!.index))
    const residual = spec.filters.filter((_, i) => !consumed.has(i))
    return {
      keyspace: keyspaceId(table.name, cand.id),
      eqPrefix,
      suffixLen: suffix.length,
      reverse: allDesc,
      residual,
    }
  }
  return null
}

/** The keyspace key for a row under an index's columns (order-preserving). */
export function indexColumns(table: TableInfo, index: string): ReadonlyArray<string> {
  if (index === PRIMARY) return [table.pk]
  const idx = table.indexes.find((i) => i.name === index)
  if (!idx) throw new Error(`unknown index ${index} on ${table.name}`)
  return idx.columns
}
