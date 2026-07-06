import type { ColumnKind, SchemaDefinition } from "./schema.js"

/**
 * Serializable, runtime view of a schema. The engine, codegen, and the wire all
 * speak this — it is the intermediate representation the DSL compiles to.
 */
export interface ColumnInfo {
  readonly name: string
  readonly kind: ColumnKind
  readonly nullable: boolean
}

export interface IndexInfo {
  readonly name: string
  /** Key columns with the primary key appended as a tiebreaker (total order). */
  readonly columns: ReadonlyArray<string>
  readonly unique: boolean
}

export interface TableInfo {
  readonly name: string
  readonly pk: string
  readonly columns: ReadonlyArray<ColumnInfo>
  readonly indexes: ReadonlyArray<IndexInfo>
  /**
   * When true, a query that no index can serve is rejected instead of falling
   * back to an O(table) scan. Set for production deployments.
   */
  readonly strictIndexes: boolean
}

export interface SchemaInfo {
  readonly tables: ReadonlyArray<TableInfo>
}

export interface CompileOptions {
  /** Reject unindexed paginated/collect queries (recommended in production). */
  readonly strictIndexes?: boolean
}

/** Reserved system table for durable scheduled jobs (Convex-style). */
export const SCHEDULED_TABLE = "_scheduled"

export function compileSchema(schema: SchemaDefinition, options: CompileOptions = {}): SchemaInfo {
  const strictIndexes = options.strictIndexes ?? false
  const tables: TableInfo[] = []
  for (const [name, def] of Object.entries(schema)) {
    let pk: string | undefined
    const columns: ColumnInfo[] = []
    const uniqueCols = new Set<string>()
    for (const [colName, col] of Object.entries(def.columns)) {
      if (col.config.primaryKey) pk = colName
      if (col.config.unique) uniqueCols.add(colName)
      columns.push({ name: colName, kind: col.config.kind, nullable: col.config.nullable })
    }
    if (!pk) throw new Error(`table "${name}" has no primaryKey() column`)
    const primaryKey = pk
    const indexes: IndexInfo[] = def.indexes.map((idx) => ({
      name: idx.name,
      // Append the pk as a tiebreaker so every index produces a total order.
      columns: idx.columns.includes(primaryKey) ? idx.columns : [...idx.columns, primaryKey],
      // Unique if the index declares it (composite unique), or it is a
      // single-column index over a column marked `.unique()`.
      unique: idx.unique || (idx.columns.length === 1 && uniqueCols.has(idx.columns[0]!)),
    }))
    tables.push({ name, pk: primaryKey, columns, indexes, strictIndexes })
  }
  return { tables }
}

export function tableInfo(schema: SchemaInfo, name: string): TableInfo {
  const t = schema.tables.find((t) => t.name === name)
  if (!t) throw new Error(`unknown table "${name}"`)
  return t
}
