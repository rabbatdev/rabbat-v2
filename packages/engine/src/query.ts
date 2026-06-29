import type { Filter, OrderKey, QuerySpec, Row, Scalar } from "@rabbat/protocol"
import { compareScalar } from "@rabbat/protocol"
import type { TableInfo } from "@rabbat/schema"
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

function likeToRegExp(pattern: string): RegExp {
  let re = "^"
  for (const ch of pattern) {
    if (ch === "%") re += ".*"
    else if (ch === "_") re += "."
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(re + "$")
}

function matchesFilter(row: Row, f: Filter): boolean {
  const v = row[f.column] ?? null
  switch (f.op) {
    case "=":
      return compareScalar(v, f.value as Scalar) === 0
    case "!=":
      return compareScalar(v, f.value as Scalar) !== 0
    case "<":
      return compareScalar(v, f.value as Scalar) < 0
    case "<=":
      return compareScalar(v, f.value as Scalar) <= 0
    case ">":
      return compareScalar(v, f.value as Scalar) > 0
    case ">=":
      return compareScalar(v, f.value as Scalar) >= 0
    case "like":
      return typeof v === "string" && likeToRegExp(String(f.value)).test(v)
    case "in":
      return (f.value as ReadonlyArray<Scalar>).some((x) => compareScalar(v, x) === 0)
  }
}

/** Does a row satisfy every filter (AND semantics)? */
export function matchesRow(row: Row, filters: ReadonlyArray<Filter>): boolean {
  for (const f of filters) if (!matchesFilter(row, f)) return false
  return true
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
