/**
 * The scalar value system. Every column value and every JSON-safe payload that
 * crosses the wire is one of these. `bytes` columns are transported as
 * base64 strings, so at the protocol level they are just `string`.
 */
export type Scalar = string | number | boolean | null

/** A row is a flat record of scalars keyed by column name. */
export type Row = Record<string, Scalar>

/** One component of a sort order. */
export interface OrderKey {
  readonly column: string
  /** `true` for descending. */
  readonly desc: boolean
}

/**
 * Total comparison of two scalars under a single direction. Mirrors the
 * order-preserving byte encoding the engine uses for index keys, so the client
 * and the server agree on row order to the bit.
 *
 * Null sorts first (smallest). Within a type, natural order. Across types we
 * fall back to a stable type rank so the order is always total.
 */
export function compareScalar(a: Scalar, b: Scalar): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0
  }
  // strings
  const sa = a as string
  const sb = b as string
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function typeRank(v: Exclude<Scalar, null>): number {
  switch (typeof v) {
    case "boolean":
      return 0
    case "number":
      return 1
    default:
      return 2 // string (and base64 bytes)
  }
}

/**
 * Compare two rows by an effective sort order (which must already include the
 * primary key as a tiebreaker so the order is total).
 */
export function compareRows(a: Row, b: Row, order: ReadonlyArray<OrderKey>): number {
  for (const key of order) {
    const c = compareScalar(a[key.column] ?? null, b[key.column] ?? null)
    if (c !== 0) return key.desc ? -c : c
  }
  return 0
}

/** Extract the sort-key tuple of a row in a given order (used to build cursors). */
export function keyOf(row: Row, order: ReadonlyArray<OrderKey>): Scalar[] {
  return order.map((k) => row[k.column] ?? null)
}
