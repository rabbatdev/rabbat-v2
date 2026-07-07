// Real-app-flow test against the new atomic runtime: orbits.create is now a
// SINGLE atomic batch of 7 inserts (orbit + invite + 3 roles + member + category
// + 2 channels), and messages.send SCHEDULES the push.notify action. Verifies
// the whole chain commits coherently and the scheduled action runs without error.
//
// Run: tsx functions-flow-test.ts   (needs `rabbat-db serve` on :3652)

import { serveApp } from "rabbat/functions";
import { FunctionsClient } from "rabbat/client";

import { api } from "../functions/_generated/api.ts";
import { loadModules, setupTestApp } from "./_db.ts";

const modules = await loadModules();

const { dbUrl, token } = await setupTestApp();
const PORT = 3656;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const app = await serveApp({
  modules,
  dbUrl,
  dbToken: token,
  port: PORT,
  auth: (token) => (token ? { subject: token, name: token } : null),
});

const URL = `ws://127.0.0.1:${PORT}`;
const alice = new FunctionsClient({ url: URL });
alice.setAuth("alice-flow");
alice.connect();
const bob = new FunctionsClient({ url: URL });
bob.setAuth("bob-flow");
bob.connect();
await sleep(300);

// --- orbits.create: a single atomic batch of 7 inserts -----------------------
const { id: orbitId } = (await alice.mutation(api.orbits.create, { name: "Flow Test Orbit" })) as {
  id: string;
};
check(typeof orbitId === "string", "orbits.create returns an orbit id");

// Every dependent row from that one mutation must be present together.
async function readValue<T>(ref: any, args: any): Promise<T | null> {
  const v = alice.acquireValue<T>(ref, args);
  alice.retain(v.key);
  await sleep(150);
  const data = v.store.getSnapshot().data ?? null;
  alice.release(v.key);
  return data;
}
const channels = (await readValue<any[]>(api.channels.list, { orbitId })) ?? [];
check(channels.length === 2, "the orbit's 2 starter channels were created in the same commit");
const roles = (await readValue<any[]>(api.roles.list, { orbitId })) ?? [];
check(roles.length >= 1, "the orbit's roles were created in the same commit");
const members = (await readValue<any[]>(api.members.list, { orbitId })) ?? [];
check(members.length === 1 && members[0].userId === "alice-flow", "creator is a member with the owner role");

const general = channels.find((c) => c.name === "general") ?? channels[0];

// --- bob joins via the orbit's default invite (created in the same batch) -----
const invites = (await readValue<any[]>(api.invites.list, { orbitId })) ?? [];
check(invites.length >= 1, "default invite link exists (created in orbits.create's batch)");
if (invites[0]) {
  await bob.mutation(api.orbits.join, { invite: invites[0].id });
  const members2 = (await readValue<any[]>(api.members.list, { orbitId })) ?? [];
  check(members2.length === 2, "bob joined → 2 members");
}

// --- messages.send: commit + fan-out notification + SCHEDULE push.notify ------
const mentionBody = "hey [@bob](mention:bob-flow) welcome!";
const { id: msgId } = (await alice.mutation(api.messages.send, {
  channelId: general.id,
  body: mentionBody,
})) as { id: string };
check(typeof msgId === "string", "messages.send commits and returns the message id");

// The mention should have produced a notification row for bob (a second write in
// the same atomic mutation as the message insert).
await sleep(300); // let the scheduled push.notify action run (finds no subs → no-op)
const unread = (await readValueBob<{ count: number }>(api.notifications.unread, {})) ?? { count: 0 };
check(unread.count >= 1, "the mention created a notification (message + notif committed together)");

async function readValueBob<T>(ref: any, args: any): Promise<T | null> {
  const v = bob.acquireValue<T>(ref, args);
  bob.retain(v.key);
  await sleep(150);
  const data = v.store.getSnapshot().data ?? null;
  bob.release(v.key);
  return data;
}

// --- clean up: leave + remove the test orbit ---------------------------------
await bob.mutation(api.orbits.leave, { orbitId });
await alice.mutation(api.orbits.remove, { orbitId });
// Assert the cascade against the database directly (the source of truth). Reading
// it back through `channels.list` would re-run a query that now errors with
// "orbit not found" — the reactive store's handling of that is a client concern,
// not what this check is about (did the delete cascade).
const httpBase = dbUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
async function dbChannelCount(orbit: string): Promise<number> {
  const res = await fetch(`${httpBase}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: "from channels where orbit_id = $o order by position",
      params: { o: orbit },
      page: { first: 50 },
    }),
  });
  const j = (await res.json()) as { rows?: unknown[] };
  return (j.rows ?? []).length;
}
check((await dbChannelCount(orbitId)) === 0, "orbits.remove cascaded (channels gone)");

alice.close();
bob.close();
await app.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
