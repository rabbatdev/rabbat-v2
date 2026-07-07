// Seed Rabbat with a populated demo orbit for "en": users, roles, categories,
// channels and a lot of varied messages. Writes directly to the shared backend's
// HTTP /mutate (an admin/offline task). Run with the backend up and this app's
// token (the one in .env):
//   RABBAT_TOKEN=$(grep RABBAT_TOKEN .env | cut -d= -f2-) pnpm --filter en seed
//
// After signing in, join the demo orbit with invite code WELCOME.

const HTTP = (process.env.RABBAT_DB_URL ?? "ws://127.0.0.1:3652/ws")
  .replace(/^ws/, "http")
  .replace(/\/ws$/, "");
// ~100 messages/channel by default — enough to feel populated. Bump it for a
// stress test of index-seek pagination / maintained counts, e.g.
// MESSAGES_PER_CHANNEL=10000 pnpm seed.
const PER_CHANNEL = Number(process.env.MESSAGES_PER_CHANNEL ?? 100);
const TOKEN = process.env.RABBAT_TOKEN ?? process.env.RABBAT_DB_TOKEN;

// Seed people. `accent` is a hue; `online` seeds presence.
const PEOPLE = [
  { id: "u_aria", name: "Aria Vance", accent: "300", online: true, owner: true, role: "Owner" },
  { id: "u_boris", name: "Boris Lange", accent: "210", online: true, role: "Admin" },
  { id: "u_cleo", name: "Cleo Park", accent: "150", online: true, role: "Admin" },
  { id: "u_dev", name: "Dev Mehta", accent: "30", online: true, role: "Member" },
  { id: "u_esme", name: "Esme Okafor", accent: "330", online: true, role: "Member" },
  { id: "u_finn", name: "Finn Adler", accent: "260", online: false, role: "Member" },
  { id: "u_goro", name: "Goro Tan", accent: "90", online: false, role: "Member" },
  { id: "u_hana", name: "Hana Reyes", accent: "0", online: false, role: "Member" },
] as const;

const BIOS: Record<string, string> = {
  u_aria: "Founder. Coffee, keyboards, and shipping on Fridays.",
  u_boris: "Infra & reliability. If it pages, I'm already awake.",
  u_cleo: "Design systems. Pixels are load-bearing.",
  u_dev: "Frontend. Mugen enthusiast.",
  u_esme: "PM. Asking 'why' until it makes sense.",
};

const ADMIN_PERMS = 2 | 4 | 16 | 32; // MANAGE_CHANNELS | MANAGE_MESSAGES | KICK_MEMBERS | CREATE_INVITE

const CATEGORIES = [
  { id: "cat_welcome", name: "Welcome", position: 0 },
  { id: "cat_team", name: "Team", position: 1 },
  { id: "cat_offtopic", name: "Off-topic", position: 2 },
];
const CHANNELS = [
  { id: "ch_general", cat: "cat_welcome", name: "general", topic: "Anything and everything." },
  { id: "ch_announce", cat: "cat_welcome", name: "announcements", topic: "Ship logs and notices." },
  { id: "ch_eng", cat: "cat_team", name: "engineering", topic: "Builds, bugs, and the query planner." },
  { id: "ch_design", cat: "cat_team", name: "design", topic: "Pixels, type, and motion." },
  { id: "ch_water", cat: "cat_offtopic", name: "watercooler", topic: "☕ idle chatter" },
];

const OPENERS = ["shipped", "looking at", "anyone seen", "quick q —", "fyi", "ok so", "heads up:", "just merged", "reviewing", "thinking about", "stuck on", "found it:", "+1 to", "reminder:", "draft of", "rolling out", "reverted", "benchmarked"];
const SUBJECTS = ["the keyset cursor fix", "the reactive re-run path", "secondary indexes", "the WAL checkpoint", "fsync latency", "the diff-only protocol", "the snapshot format", "the orbit permissions", "the pagination window", "the auth middleware", "the codegen step", "the schema in TS", "the unread badges", "the functions server", "the live tail", "presence heartbeats"];
const TAILS = ["— much cleaner now.", "lmk what you think.", "tests are green.", "still O(n) though.", "down to ~170µs.", "should we ship it?", "edge case incoming.", "will write it up.", "needs a second pair of eyes.", "no rush.", "this is the one.", "🚀", "🤔", ""];
const TINY = ["👍", "lgtm", "ok", "ship it", "🚀", "nice", "+1", "🎉", "done", "👀", "agreed", "on it", "thanks!", "yep", "🤔", "🔥", "💯", "haha", "good catch"];
const CODE = [
  "```\nfrom messages\nwhere channel_id = $c\norder by created_at desc\nlimit 50\n```",
  "the three layers:\n  • Postgres storage (document/index/commit)\n  • the reactive engine (IVM)\n  • the functions server (typed, perm-checked)\neach is independently testable.",
  "```ts\nconst orbit = useOrbit();\nif (hasPerm(orbit, Perm.MANAGE_CHANNELS)) showCreate();\n```",
];

const pick = <T>(a: readonly T[], r: number) => a[Math.floor(r * a.length) % a.length];
let seed = 987654;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sentence = () => `${pick(OPENERS, rnd())} ${pick(SUBJECTS, rnd())} ${pick(TAILS, rnd())}`.trim();
const para = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, sentence).join(" ");
function body(): string {
  const n = rnd();
  if (n < 0.36) return pick(TINY, rnd());
  if (n < 0.72) return sentence();
  if (n < 0.88) return `${sentence()}\n${sentence()}`;
  if (n < 0.96) return para();
  return pick(CODE, rnd());
}

async function mutate(mutations: unknown[]) {
  const res = await fetch(`${HTTP}/mutate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ mutations }),
  });
  if (!res.ok) throw new Error(`mutate failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const orbitId = "orbit_demo";
  const createdAt = now - 20 * 86_400_000;

  console.log(`Seeding ${HTTP} — demo orbit "Mission Control" (invite WELCOME)`);

  // Users + presence.
  const setup: unknown[] = [];
  for (const p of PEOPLE) {
    setup.push({
      op: "insert",
      table: "user",
      row: {
        id: p.id,
        name: p.name,
        // Seed a handle so demo users are complete on insert (no startup
        // backfill scan needed) — `p.id` is `u_<handle>`, e.g. `u_aria` → `aria`.
        username: p.id.slice(2),
        email: `${p.id.slice(2)}@en.demo`,
        emailVerified: true,
        image: null,
        bio: BIOS[p.id] ?? null,
        accent: p.accent,
        createdAt: iso(createdAt),
        updatedAt: iso(createdAt),
      },
    });
    setup.push({
      op: "insert",
      table: "presence",
      row: { user_id: p.id, last_seen: p.online ? now : now - 3 * 3_600_000, status: p.online ? "online" : "offline" },
    });
  }

  // Orbit + a permanent WELCOME invite link + roles.
  setup.push({ op: "insert", table: "orbits", row: { id: orbitId, name: "Mission Control", invite: null, hue: 300, owner_id: "u_aria", created_at: createdAt } });
  setup.push({ op: "insert", table: "invites", row: { id: "WELCOME", orbit_id: orbitId, creator_id: "u_aria", expires_at: null, max_uses: null, uses: 0, created_at: createdAt } });
  setup.push({ op: "insert", table: "roles", row: { id: "role_admin", orbit_id: orbitId, name: "Admin", permissions: ADMIN_PERMS, color: "210", position: 1, created_at: createdAt } });
  setup.push({ op: "insert", table: "roles", row: { id: "role_member", orbit_id: orbitId, name: "Member", permissions: 0, color: null, position: 2, created_at: createdAt } });

  // Members (joined_at = now so seeded history reads as already-seen).
  for (const p of PEOPLE) {
    const roleId = p.role === "Admin" ? "role_admin" : "role_member";
    setup.push({ op: "insert", table: "members", row: { id: `mem_${p.id}`, orbit_id: orbitId, user_id: p.id, role_id: roleId, joined_at: now } });
  }

  // Categories + channels.
  for (const c of CATEGORIES) setup.push({ op: "insert", table: "categories", row: { id: c.id, orbit_id: orbitId, name: c.name, position: c.position } });
  CHANNELS.forEach((ch, i) =>
    setup.push({ op: "insert", table: "channels", row: { id: ch.id, orbit_id: orbitId, category_id: ch.cat, name: ch.name, topic: ch.topic, position: i, created_at: createdAt } }),
  );
  await mutate(setup);

  // Messages per channel, spread over the last ~14 days ending ~10 min ago.
  for (let c = 0; c < CHANNELS.length; c++) {
    const ch = CHANNELS[c];
    const span = 14 * 86_400_000;
    const start = now - span - c * 1_800_000;
    const end = now - 10 * 60_000;
    let batch: unknown[] = [];
    const ids: string[] = [];
    for (let i = 0; i < PER_CHANNEL; i++) {
      const mid = `msg_${c}_${i}`;
      const at = Math.floor(start + ((end - start) * i) / PER_CHANNEL);
      const replyTo = ids.length > 5 && rnd() < 0.14 ? pick(ids, rnd()) : null;
      batch.push({
        op: "insert",
        table: "messages",
        row: { id: mid, channel_id: ch.id, author_id: pick(PEOPLE, rnd()).id, body: body(), edited: rnd() < 0.05 ? true : null, reply_to: replyTo, created_at: at },
      });
      ids.push(mid);
      if (batch.length >= 1000) {
        await mutate(batch);
        batch = [];
      }
    }
    if (batch.length) await mutate(batch);
    console.log(`  #${ch.name}: ${PER_CHANNEL} messages`);
  }
  console.log("Done. Sign in, then join orbit with invite WELCOME.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
