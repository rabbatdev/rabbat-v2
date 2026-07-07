// Integration test for the functions layer: browser client → functions server
// → Rabbat. Starts the functions server in-process against a running Rabbat.
//
// Run: tsx functions-test.ts   (needs `rabbat-db serve` on :3652)

import { serveApp } from "rabbat/functions";
import { FunctionsClient } from "rabbat/client";

import { api } from "../functions/_generated/api.ts";
import { loadModules, setupTestApp } from "./_db.ts";

const modules = await loadModules();

const { dbUrl, token } = await setupTestApp();
const PORT = 3659; // in-process test server, inside the 365x block
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const app = await serveApp({
  modules,
  dbUrl,
  dbToken: token, // the app's RABBAT_TOKEN authenticates + selects its data
  port: PORT,
  auth: (token) => (token ? { subject: token, name: token } : null),
});

const URL = `ws://127.0.0.1:${PORT}`;
const alice = new FunctionsClient({ url: URL });
alice.setAuth("alice");
alice.connect();
await sleep(250);

// --- mutation returns server-generated id; create an orbit (which seeds owner
//     membership + two starter channels, "general" and "random") ---
const { id: orbitId } = (await alice.mutation(api.orbits.create, { name: "Test Orbit" })) as {
  id: string;
};
check(typeof orbitId === "string", "mutation returns created orbit id");

// --- reactive value query: channels.list (the orbit ships with starters) ---
const channels = alice.acquireValue<any[]>(api.channels.list, { orbitId });
alice.retain(channels.key);
await sleep(200);
const starters = channels.store.getSnapshot().data ?? [];
check(starters.length === 2, "channels.list (reactive value) shows the 2 starter channels");
const channelId = (starters.find((c: any) => c.name === "general") ?? starters[0])?.id as string;
check(typeof channelId === "string", "found the general channel");

// --- reactive paginated query: messages.list, tail window of 3 ---
const messages = alice.acquirePaginated<any>(api.messages.list, { channelId }, {
  before: 3,
  after: 0,
  anchor: { kind: "latest" },
});
alice.retain(messages.key);
await sleep(200);
check(messages.store.getSnapshot().data.length === 0, "messages empty initially");

for (let i = 1; i <= 5; i++) {
  await alice.mutation(api.messages.send, { channelId, body: `message ${i}` });
}
await sleep(300);
let snap = messages.store.getSnapshot();
check(snap.data.length === 3, "tail window shows newest 3");
check(snap.data.at(-1)?.author_id === "alice", "author is taken from the authenticated identity");
check(snap.total === 5, "total reflects all messages");
check(snap.hasOlder === true, "hasOlder: older messages exist");

// --- loadOlder grows the window backward (infinite pagination) ---
alice.loadOlder(messages.key, 5);
await sleep(250);
snap = messages.store.getSnapshot();
check(snap.data.length === 5, "after loadOlder all 5 are loaded");
check(snap.hasOlder === false, "hasOlder false once fully loaded");
check(
  snap.data.every((m: any, i: number) => i === 0 || m.created_at >= snap.data[i - 1].created_at),
  "rows ordered ascending",
);

// --- jump: anchor the window AROUND a target (not everything in between) ---
const sortedIds = snap.data.map((m: any) => m.id);
const midId = sortedIds[2];
alice.setAnchor(messages.key, { kind: "key", key: midId }, 1, 2); // 1 before, anchor + 1 after
await sleep(250);
snap = messages.store.getSnapshot();
const windowIds = snap.data.map((m: any) => m.id);
check(
  windowIds.length === 3 && windowIds[1] === midId,
  "anchored window loads a slice around the target (3 rows, target centered)",
);
check(!windowIds.includes(sortedIds[0]), "the oldest row was evicted (not loaded between)");
check(snap.hasOlder === true && snap.hasNewer === true, "more rows exist on both sides");

// Back to the latest tail.
alice.setAnchor(messages.key, { kind: "latest" }, 3, 0);
await sleep(250);
snap = messages.store.getSnapshot();
check(snap.data.length === 3 && snap.data.at(-1)?.id === sortedIds[4], "back-to-latest shows the newest tail");

// --- live edit reflects reactively ---
alice.setAnchor(messages.key, { kind: "latest" }, 10, 0);
await sleep(200);
snap = messages.store.getSnapshot();
const firstId = snap.data[0].id;
await alice.mutation(api.messages.edit, { id: firstId, body: "edited live!" });
await sleep(250);
snap = messages.store.getSnapshot();
check(snap.data[0].body === "edited live!" && snap.data[0].edited === true, "edit applies reactively");

// --- channels.list reacts to a new channel ---
await alice.mutation(api.channels.create, { orbitId, name: "extra" });
await sleep(250);
check((channels.store.getSnapshot().data ?? []).length === 3, "channels.list reacts to new channel");

// --- auth: an unauthenticated client cannot mutate ---
const anon = new FunctionsClient({ url: URL });
anon.connect();
await sleep(150);
let anonRejected = false;
try {
  await anon.mutation(api.channels.create, { orbitId, name: "nope" });
} catch {
  anonRejected = true;
}
check(anonRejected, "unauthenticated mutation is rejected (auth enforced server-side)");

// --- ownership: cannot edit someone else's message ---
const bob = new FunctionsClient({ url: URL });
bob.setAuth("bob");
bob.connect();
await sleep(150);
let bobRejected = false;
try {
  await bob.mutation(api.messages.edit, { id: firstId, body: "hacked" });
} catch {
  bobRejected = true;
}
check(bobRejected, "cannot edit another user's message");

alice.close();
anon.close();
bob.close();
await app.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
