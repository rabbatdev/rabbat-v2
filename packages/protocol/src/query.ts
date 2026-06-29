import type { OrderKey, Scalar } from "./values.js"

/** Comparison operators in a structured query (RQL). */
export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "in"

export interface Filter {
  readonly column: string
  readonly op: CompareOp
  readonly value: Scalar | ReadonlyArray<Scalar>
}

/**
 * The structured query the `ctx.db` builder compiles to and the engine executes.
 * Values are already bound (no late params). The primary key is appended to the
 * order by the engine for a total, cursor-stable ordering.
 */
export interface QuerySpec {
  readonly table: string
  readonly filters: ReadonlyArray<Filter>
  readonly order: ReadonlyArray<OrderKey>
}
