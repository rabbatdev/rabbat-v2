/**
 * The schema DSL — the single source of truth for your data model. It is pure
 * TypeScript with zero runtime dependencies (safe to import into a browser
 * bundle): the same `schema` object drives `DataModelOf<>` type inference for
 * `ctx.db`, the engine's column/index metadata, and codegen.
 */

export type ColumnKind = "bool" | "int" | "float" | "text" | "bytes"

export interface ColumnConfig {
  readonly kind: ColumnKind
  readonly nullable: boolean
  readonly primaryKey: boolean
  readonly unique: boolean
  readonly indexed: boolean
}

/** The TS type a column kind maps to at runtime. `bytes` transports as base64. */
type TsOf<K extends ColumnKind> = K extends "bool"
  ? boolean
  : K extends "int" | "float"
    ? number
    : string

export class Column<Ts, Nullable extends boolean, Pk extends boolean> {
  declare readonly _ts: Ts
  declare readonly _nullable: Nullable
  declare readonly _pk: Pk

  constructor(readonly config: ColumnConfig) {}

  nullable(): Column<Ts, true, Pk> {
    return new Column({ ...this.config, nullable: true })
  }
  primaryKey(): Column<Ts, false, true> {
    return new Column({ ...this.config, primaryKey: true, nullable: false })
  }
  unique(): Column<Ts, Nullable, Pk> {
    return new Column({ ...this.config, unique: true, indexed: true })
  }
  index(): Column<Ts, Nullable, Pk> {
    return new Column({ ...this.config, indexed: true })
  }
}

function col<K extends ColumnKind>(kind: K): Column<TsOf<K>, false, false> {
  return new Column({
    kind,
    nullable: false,
    primaryKey: false,
    unique: false,
    indexed: false,
  })
}

/** Column-type builders. */
export const s = {
  bool: () => col("bool"),
  int: () => col("int"),
  float: () => col("float"),
  text: () => col("text"),
  /** Binary column; transported as a base64 string (TS type `string`). */
  bytes: () => col("bytes"),
}

export type Columns = Record<string, Column<any, boolean, boolean>>

export interface IndexConfig {
  readonly name: string
  /** Index key columns; the primary key is appended automatically as a tiebreaker. */
  readonly columns: ReadonlyArray<string>
  /** Enforce uniqueness over the key columns (composite unique constraint). */
  readonly unique: boolean
}

export type IndexSpec<C extends Columns> =
  | ReadonlyArray<keyof C & string>
  | {
      readonly name: string
      readonly columns: ReadonlyArray<keyof C & string>
      /** Enforce a (composite) unique constraint over `columns`. */
      readonly unique?: boolean
    }

export interface TableOptions<C extends Columns> {
  readonly indexes?: ReadonlyArray<IndexSpec<C>>
}

export interface TableDefinition<C extends Columns> {
  readonly columns: C
  readonly indexes: ReadonlyArray<IndexConfig>
}

export function defineTable<C extends Columns>(
  columns: C,
  options: TableOptions<C> = {},
): TableDefinition<C> {
  const explicit: IndexConfig[] = (options.indexes ?? []).map((spec) => {
    if (Array.isArray(spec)) {
      return { name: spec.join("_"), columns: spec as ReadonlyArray<string>, unique: false }
    }
    const o = spec as { name: string; columns: ReadonlyArray<string>; unique?: boolean }
    return { name: o.name, columns: o.columns, unique: o.unique ?? false }
  })
  // Single-column indexes declared via `.index()` / `.unique()` on a column.
  const single: IndexConfig[] = []
  for (const [name, c] of Object.entries(columns)) {
    if (c.config.indexed && !explicit.some((i) => i.columns.length === 1 && i.columns[0] === name)) {
      single.push({ name, columns: [name], unique: c.config.unique })
    }
  }
  const all = [...single, ...explicit]
  // Index names map 1:1 to keyspaces; a duplicate would silently merge two
  // different indexes' data into one keyspace. Reject at definition time.
  const seen = new Set<string>()
  for (const idx of all) {
    if (seen.has(idx.name)) throw new Error(`duplicate index name "${idx.name}"`)
    seen.add(idx.name)
  }
  return { columns, indexes: all }
}

export type SchemaDefinition = Record<string, TableDefinition<Columns>>

export function defineSchema<S extends SchemaDefinition>(schema: S): S {
  return schema
}

// ── Type inference ──────────────────────────────────────────────────────────

type ColTs<T> = T extends Column<infer Ts, infer N, any> ? (N extends true ? Ts | null : Ts) : never

type RequiredInsertKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<any, infer N, any> ? (N extends true ? never : K) : never
}[keyof C]

type OptionalInsertKeys<C extends Columns> = Exclude<keyof C, RequiredInsertKeys<C>>

/** Full row shape: every column present. */
export type RowOf<C extends Columns> = { [K in keyof C]: ColTs<C[K]> }

/** Insert shape: nullable columns optional. */
export type InsertOf<C extends Columns> = {
  [K in RequiredInsertKeys<C>]: ColTs<C[K]>
} & {
  [K in OptionalInsertKeys<C>]?: ColTs<C[K]>
}

/** Primary-key column name. */
export type PkOf<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<any, any, infer Pk> ? (Pk extends true ? K : never) : never
}[keyof C] &
  string

/** Patch shape: every column optional, primary key omitted. */
export type PatchOf<C extends Columns> = {
  [K in Exclude<keyof C, PkOf<C>>]?: ColTs<C[K]>
}

export interface TableModel<C extends Columns> {
  readonly row: RowOf<C>
  readonly insert: InsertOf<C>
  readonly patch: PatchOf<C>
  readonly pk: PkOf<C>
}

export type DataModelOf<S extends SchemaDefinition> = {
  [T in keyof S]: S[T] extends TableDefinition<infer C> ? TableModel<C> : never
}

/** A generic data model, used where the concrete schema is erased. */
export type DataModel = Record<string, TableModel<Columns>>

export type Row<S extends SchemaDefinition, T extends keyof S> = DataModelOf<S>[T]["row"]
