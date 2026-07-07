// rabbat/schema → @rabbat/schema.
//
// Explicit named re-exports (not just `export *`): a barrel `.d.ts` whose ONLY
// statement is `export * from "pkg"` doesn't reliably forward named/type exports
// under `moduleResolution: bundler`, so we name the public surface here.
export * from "@rabbat/schema"
export { s, defineSchema, defineTable, compileSchema, tableInfo, SCHEDULED_TABLE } from "@rabbat/schema"
export type {
  DataModelOf,
  DataModel,
  Row,
  RowOf,
  InsertOf,
  PatchOf,
  PkOf,
  TableModel,
  Column,
  Columns,
  ColumnKind,
  ColumnConfig,
  IndexSpec,
  IndexConfig,
  TableOptions,
  TableDefinition,
  SchemaDefinition,
  ColumnInfo,
  IndexInfo,
  TableInfo,
  SchemaInfo,
  CompileOptions,
} from "@rabbat/schema"
