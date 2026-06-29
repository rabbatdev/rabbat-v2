import type { SchemaInfo, TableInfo } from "@rabbat/schema"
import { SCHEDULED_TABLE } from "@rabbat/schema"

/**
 * The reserved system table backing the durable scheduler. It mirrors the
 * shape the engine expects for queued/scheduled jobs and is appended to every
 * generated schema IR so a backend can materialize it without the app author
 * declaring it.
 */
function scheduledTable(): TableInfo {
  return {
    name: SCHEDULED_TABLE,
    pk: "id",
    columns: [
      { name: "id", kind: "text", nullable: false },
      { name: "run_at", kind: "int", nullable: false },
      { name: "fn", kind: "text", nullable: false },
      { name: "args", kind: "text", nullable: false },
      { name: "kind", kind: "text", nullable: false },
      { name: "state", kind: "text", nullable: false },
      { name: "attempts", kind: "int", nullable: false },
      { name: "created_at", kind: "int", nullable: false },
    ],
    indexes: [{ name: "run_at", columns: ["run_at", "id"], unique: false }],
  }
}

/**
 * Produce the serializable IR (pretty-printed JSON, 2-space indent) for a
 * compiled schema, including the reserved durable-scheduler system table. A
 * backend can load this JSON directly to provision tables and indexes.
 */
export function generateSchemaJson(schema: SchemaInfo): string {
  const out: SchemaInfo = {
    tables: [...schema.tables, scheduledTable()],
  }
  return JSON.stringify(out, null, 2)
}
