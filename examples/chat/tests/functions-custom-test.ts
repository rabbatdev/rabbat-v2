// The full customQuery (Convex-helpers) shape: a customizer with extra `args`
// that `input` consumes, returning `{ ctx, args, onSuccess }` merged into the
// handler — `ctx` additions, `args` additions, and a post-run `onSuccess`.

import { customQuery, defineFunctions, serveApp, v } from "rabbat/functions";
import { FunctionsClient } from "rabbat/client";

import { setupTestApp } from "./_db.ts";

const { dbUrl, token } = await setupTestApp();
const PORT = 3659;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const { query } = defineFunctions<any>();

let onSuccessSeen: { args: Record<string, unknown>; result: any } | null = null;
// Extra `apiToken` arg → input derives `ctx.caller`, adds `args.stamped`, and
// registers an onSuccess that observes the final args + result.
const richQuery = customQuery(query, {
  args: { apiToken: v.string() },
  input: async (_ctx, { apiToken }) => ({
    ctx: { caller: `user:${apiToken}` },
    args: { stamped: true },
    onSuccess: ({ args, result }) => {
      onSuccessSeen = { args, result };
    },
  }),
});

const whoami = richQuery({
  args: { greeting: v.string() },
  handler: async (ctx, args) => ({ caller: ctx.caller, greeting: args.greeting, stamped: args.stamped }),
});

const app = await serveApp({
  modules: { test: { whoami } },
  dbUrl,
  dbToken: token,
  port: PORT,
  auth: () => null,
});

const ref = { __isFunctionReference: true, __kind: "query", name: "test:whoami" } as any;
const client = new FunctionsClient({ url: `ws://127.0.0.1:${PORT}` });
client.connect();
await sleep(200);

// Caller supplies BOTH the customizer's arg (apiToken) and the function's (greeting).
const sub = client.acquireValue<any>(ref, { apiToken: "abc", greeting: "hi" });
client.retain(sub.key);
await sleep(300);
const data = sub.store.getSnapshot().data;
check(data?.caller === "user:abc", "input-derived ctx (caller) reaches the handler");
check(data?.greeting === "hi", "the function's own arg passes through");
check(data?.stamped === true, "input-added arg (stamped) reaches the handler");
await sleep(50);
check((onSuccessSeen as any)?.result?.caller === "user:abc", "onSuccess runs with the handler result");
check(
  (onSuccessSeen as any)?.args?.greeting === "hi" && (onSuccessSeen as any)?.args?.stamped === true,
  "onSuccess sees the merged args (fn + input-added)",
);

client.close();
await app.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
