// A Better Auth database adapter backed by Rabbat.
//
// Better Auth's adapter is a plain async object the library calls inline while
// handling a request — an imperative read+write pattern that maps cleanly onto
// `@rabbat/db`'s structured `RabbatDb` client (chained `.where()` reads +
// atomic `.mutate()` batches), the reason this maps far more cleanly than the
// Convex adapter does.
//
// Gap handling (no DB changes required — all expressed with the builder API):
//   • in / not_in           → native `in`; not_in expands to ANDed `!=` filters
//   • contains/starts/ends  → native `like` with %/_ wildcards
//   • offset                → over-fetch (take) + slice (auth tables are tiny)
//   • atomic multi-row write → one `db.mutate([...])` batch (single txn)
//   • unique email/token    → enforced by the DB (a duplicate insert throws a
//                             RabbatDbError, which Better Auth treats as a
//                             constraint error)
//   • OR connectors         → per-branch queries merged by id (core auth tables
//                             use AND-only; OR is a rare plugin path)
// The one true gap — an interactive read+write transaction — is left to Better
// Auth's sequential fallback; unique constraints cover the races that matter
// (duplicate user / account / session token).

import { createAdapter } from "better-auth/adapters";
import type { DbWrite } from "rabbat/client-core";
import type { RabbatClient } from "rabbat/client-core";

import { defaultDisplayName, generateUniqueUsername } from "./username.ts";

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;

/** RabbatDb compare operators (a subset used by the auth adapter). */
type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "in";

interface Where {
  field: string;
  value: Scalar | Scalar[] | Date;
  operator?: string;
  connector?: "AND" | "OR";
}

/** Dates ride as ISO strings (Rabbat columns are `text`). */
const toScalar = (v: Where["value"]): Scalar => (v instanceof Date ? v.toISOString() : (v as Scalar));

/**
 * Translate one Better Auth condition into the RabbatDb filters to AND onto a
 * query builder. Returns `"impossible"` (statically empty, e.g. `in []`),
 * `"skip"` (no constraint, e.g. `not_in []`), or one-or-more `{ op, value }`
 * filters (not_in expands to several ANDed `!=`).
 */
function clauseFilters(
  w: Where,
): "impossible" | "skip" | Array<{ op: CompareOp; value: Scalar | Scalar[] }> {
  const op = w.operator ?? "eq";
  const v = toScalar(w.value);
  switch (op) {
    case "eq": return [{ op: "=", value: v }];
    case "ne": return [{ op: "!=", value: v }];
    case "lt": return [{ op: "<", value: v }];
    case "lte": return [{ op: "<=", value: v }];
    case "gt": return [{ op: ">", value: v }];
    case "gte": return [{ op: ">=", value: v }];
    case "contains": return [{ op: "like", value: `%${v}%` }];
    case "starts_with": return [{ op: "like", value: `${v}%` }];
    case "ends_with": return [{ op: "like", value: `%${v}` }];
    case "in": {
      const arr = (Array.isArray(w.value) ? w.value : [w.value]) as Scalar[];
      if (arr.length === 0) return "impossible";
      return [{ op: "in", value: arr }];
    }
    case "not_in": {
      const arr = (Array.isArray(w.value) ? w.value : [w.value]) as Scalar[];
      if (arr.length === 0) return "skip"; // excludes nothing → no constraint
      return arr.map((x) => ({ op: "!=" as CompareOp, value: x }));
    }
    default: return [{ op: "=", value: v }];
  }
}

/** A query builder over one model with all `where` clauses ANDed on. */
function buildAndQuery(client: RabbatClient, model: string, where: readonly Where[]) {
  const q = client.table(model);
  for (const w of where) {
    const fs = clauseFilters(w);
    if (fs === "impossible") return { q, impossible: true as const };
    if (fs === "skip") continue;
    for (const f of fs) {
      if (f.op === "in") q.where(w.field, "in", f.value as Scalar[]);
      else q.where(w.field, f.op, f.value as Scalar);
    }
  }
  return { q, impossible: false as const };
}

/** Stable client-side sort (used only on the OR-merge path). */
function sortRows(rows: Row[], sortBy: { field: string; direction: "asc" | "desc" }): Row[] {
  const dir = sortBy.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sortBy.field];
    const bv = b[sortBy.field];
    if (av == null && bv == null) return 0;
    if (av == null) return -dir;
    if (bv == null) return dir;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

/** Run a select against Rabbat, applying sort / offset / limit. */
async function selectRows(
  client: RabbatClient,
  model: string,
  where?: readonly Where[],
  opts: { sortBy?: { field: string; direction: "asc" | "desc" }; limit?: number; offset?: number } = {},
): Promise<Row[]> {
  const clauses = where ?? [];
  const offset = opts.offset ?? 0;
  let rows: Row[];

  // OR is a rare plugin path: run each clause as its own AND branch and union by
  // id. Order/offset/limit are then applied client-side over the merged set.
  const hasOr = clauses.some((w, i) => i > 0 && w.connector === "OR");
  if (hasOr) {
    const byKey = new Map<string, Row>();
    for (const w of clauses) {
      const { q, impossible } = buildAndQuery(client, model, [w]);
      if (impossible) continue;
      for (const r of (await q.collect()) as Row[]) {
        const key = String(r.id ?? JSON.stringify(r));
        if (!byKey.has(key)) byKey.set(key, r);
      }
    }
    rows = [...byKey.values()];
    if (opts.sortBy) rows = sortRows(rows, opts.sortBy);
  } else {
    const { q, impossible } = buildAndQuery(client, model, clauses);
    if (impossible) return [];
    if (opts.sortBy) q.order(opts.sortBy.field, opts.sortBy.direction);
    // Over-fetch (offset + limit) then slice — auth tables are tiny.
    rows = (opts.limit != null ? await q.take(offset + opts.limit) : await q.collect()) as Row[];
  }

  if (offset) rows = rows.slice(offset);
  if (opts.limit != null) rows = rows.slice(0, opts.limit);
  return rows;
}

/** Create the Better Auth adapter. `client` is a connected, privileged RabbatClient. */
export function rabbatAdapter(client: RabbatClient) {
  return createAdapter({
    config: {
      adapterId: "rabbat",
      adapterName: "Rabbat",
      usePlural: false,
      supportsNumericIds: false,
      supportsJSON: false,
      supportsDates: false, // Dates ↔ ISO strings (Rabbat columns are `text`)
      supportsBooleans: true,
    },
    adapter: () => ({
      async create({ model, data }) {
        const row = data as Row;
        // Every user starts with a display name and a unique @username.
        if (model === "user") {
          if (typeof row.name !== "string" || !row.name.trim()) row.name = defaultDisplayName(row);
          if (row.username == null || String(row.username).trim() === "") {
            row.username = await generateUniqueUsername(client, String(row.email ?? row.name ?? ""));
          }
        }
        // A duplicate (unique email/token/username) throws RabbatDbError, which
        // Better Auth surfaces as a constraint error.
        await client.insert(model, row);
        return row as never;
      },

      async findOne({ model, where }) {
        const rows = await selectRows(client, model, where as Where[], { limit: 1 });
        return (rows[0] ?? null) as never;
      },

      async findMany({ model, where, limit, sortBy, offset }) {
        const rows = await selectRows(client, model, where as Where[], { limit, sortBy, offset });
        return rows as never[];
      },

      async update({ model, where, update }) {
        const rows = await selectRows(client, model, where as Where[], { limit: 1 });
        if (!rows[0]) return null;
        const id = rows[0].id as string;
        await client.patch(model, id, update as Row);
        return { ...rows[0], ...(update as Row) } as never;
      },

      async updateMany({ model, where, update }) {
        const rows = await selectRows(client, model, where as Where[]);
        if (rows.length === 0) return 0;
        // One atomic batch — every patch lands, or none do.
        const writes: DbWrite[] = rows.map((r) => ({
          kind: "patch",
          table: model,
          pk: r.id as string,
          fields: update as Row,
        }));
        await client.mutate(writes);
        return rows.length;
      },

      async delete({ model, where }) {
        const rows = await selectRows(client, model, where as Where[], { limit: 1 });
        if (rows[0]) await client.delete(model, rows[0].id as string);
      },

      async deleteMany({ model, where }) {
        const rows = await selectRows(client, model, where as Where[]);
        if (rows.length === 0) return 0;
        const writes: DbWrite[] = rows.map((r) => ({ kind: "delete", table: model, pk: r.id as string }));
        await client.mutate(writes);
        return rows.length;
      },

      async count({ model, where }) {
        // Auth tables are tiny — count by collecting matching rows.
        const rows = await selectRows(client, model, where as Where[]);
        return rows.length;
      },
    }),
  });
}
