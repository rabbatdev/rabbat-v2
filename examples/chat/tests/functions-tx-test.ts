// Integration test for the NEW runtime semantics: atomic mutations, the
// scheduler, actions (runQuery/runMutation), and internal-function gating.
//
// Uses the `presence` table (user_id pk, last_seen, status) as a scratch space,
// tagging rows with status="tx-marker" so it can clean up after itself.
//
// Run: tsx functions-tx-test.ts   (needs `rabbat-db serve` on :3652)

import { serveApp, defineFunctions, v } from "rabbat/functions";
import { FunctionsClient } from "rabbat/client";
import type { DataModelOf } from "rabbat/schema";

import { schema } from "../schema.ts";
import { setupTestApp } from "./_db.ts";

const { dbUrl, token } = await setupTestApp();
const PORT = 3658;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const { query, mutation, action, internalMutation } = defineFunctions<DataModelOf<typeof schema>>();

const mark = (id: string) => ({ user_id: id, last_seen: 1, status: "tx-marker" });

const tx = {
  getPresence: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.get("presence", id) }),

  cleanup: mutation({
    args: {},
    handler: async (ctx) => {
      const rows = await ctx.db.table("presence").where("status", "=", "tx-marker").collect();
      for (const r of rows) await ctx.db.delete("presence", r.user_id);
      return { removed: rows.length };
    },
  }),

  // Two writes then a throw → the batch never flushes → NOTHING is written.
  failHalfway: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("presence", mark("tx-fail-a"));
      await ctx.db.insert("presence", mark("tx-fail-b"));
      throw new Error("boom");
    },
  }),

  // Two writes, no throw → both commit together.
  okMulti: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("presence", mark("tx-ok-a"));
      await ctx.db.insert("presence", mark("tx-ok-b"));
    },
  }),

  // Internal: callable from the scheduler / action, NOT from the browser.
  insertOne: internalMutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      await ctx.db.insert("presence", mark(id));
    },
  }),

  // Commits one row, then schedules an internal mutation to write a second.
  scheduleInsert: mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("presence", mark("tx-sched-now"));
      ctx.scheduler.runAfter(0, { name: "tx:insertOne" } as never, { id: "tx-sched-later" });
    },
  }),

  // Schedules a job then throws. The job must NEVER run: scheduled work fires
  // only after a successful commit, so a rolled-back mutation schedules nothing.
  scheduleThenFail: mutation({
    args: {},
    handler: (ctx) => {
      ctx.scheduler.runAfter(0, { name: "tx:insertOne" } as never, { id: "tx-sched-rollback" });
      throw new Error("boom");
    },
  }),

  // Action: reaches the DB only via run* (each its own transaction).
  echo: action({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      await ctx.runMutation({ name: "tx:insertOne" } as never, { id });
      const p = (await ctx.runQuery({ name: "tx:getPresence" } as never, { id })) as { user_id: string } | null;
      return { found: !!p };
    },
  }),
};

const app = await serveApp({
  modules: { tx },
  dbUrl,
  dbToken: token,
  port: PORT,
  auth: (token) => (token ? { subject: token, name: token } : null),
});

const URL = `ws://127.0.0.1:${PORT}`;
const c = new FunctionsClient({ url: URL });
c.setAuth("tester");
c.connect();
await sleep(250);

// Helper: read a presence row through a one-shot subscription value.
async function exists(id: string): Promise<boolean> {
  const v = c.acquireValue<{ user_id: string } | null>({ name: "tx:getPresence" } as never, { id });
  c.retain(v.key);
  await sleep(120);
  const row = v.store.getSnapshot().data ?? null;
  c.release(v.key);
  return !!row;
}

await c.mutation({ name: "tx:cleanup" } as never, {});

// --- atomicity: a throw rolls back ALL of the mutation's writes ---
let threw = false;
try {
  await c.mutation({ name: "tx:failHalfway" } as never, {});
} catch {
  threw = true;
}
check(threw, "failing mutation rejects");
check(!(await exists("tx-fail-a")) && !(await exists("tx-fail-b")), "BOTH writes rolled back (atomic)");

// --- a successful multi-write mutation commits every write ---
await c.mutation({ name: "tx:okMulti" } as never, {});
check((await exists("tx-ok-a")) && (await exists("tx-ok-b")), "successful multi-write commits all rows");

// --- scheduler: the scheduled mutation runs AFTER the commit ---
await c.mutation({ name: "tx:scheduleInsert" } as never, {});
check(await exists("tx-sched-now"), "scheduling mutation's own write is committed");
await sleep(300);
check(await exists("tx-sched-later"), "scheduled mutation ran after commit");

// --- scheduling is bound to commit: a rolled-back mutation fires no jobs ---
let schedFailed = false;
try {
  await c.mutation({ name: "tx:scheduleThenFail" } as never, {});
} catch {
  schedFailed = true;
}
await sleep(200);
check(schedFailed, "schedule-then-throw mutation rejects");
check(!(await exists("tx-sched-rollback")), "a rolled-back mutation's scheduled job never runs");

// --- action: client.action runs runMutation + runQuery ---
const echoed = (await c.action({ name: "tx:echo" } as never, { id: "tx-echo" })) as { found: boolean };
check(echoed?.found === true, "action's runMutation + runQuery both worked");
check(await exists("tx-echo"), "action's write is visible afterwards");

// --- internal gating: the browser cannot call an internal mutation ---
let blocked = false;
try {
  await c.mutation({ name: "tx:insertOne" } as never, { id: "tx-should-not-exist" });
} catch {
  blocked = true;
}
check(blocked, "internal mutation is NOT callable from the browser");
check(!(await exists("tx-should-not-exist")), "blocked internal call wrote nothing");

// --- calling a query as an action (wrong kind) is rejected ---
let wrongKind = false;
try {
  await c.action({ name: "tx:getPresence" } as never, { id: "x" });
} catch {
  wrongKind = true;
}
check(wrongKind, "calling a query via action() is rejected (kind-checked)");

await c.mutation({ name: "tx:cleanup" } as never, {});
c.close();
await app.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
