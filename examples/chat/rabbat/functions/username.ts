// Default identity generation: every user gets a display name and a unique
// @username. Used both when a user is first created (the Better Auth adapter)
// and to backfill existing rows whose username is still null.
//
// Uniqueness strategy: derive a friendly base from the email/name, append a
// random suffix, and check the DB for a collision — widening the random part on
// each miss, with a near-collision-free long-random fallback. The `username`
// column's UNIQUE constraint is the ultimate backstop against the (tiny) race
// between the check and the write.

import type { RabbatClient } from "rabbat/client-core";

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;

// Mirror of profile.ts's USERNAME_RE — keep generated handles editable by users.
const HANDLE_RE = /^[a-z0-9_.]{3,20}$/;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function rand(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** A clean `[a-z0-9_.]` base (2–14 chars) from an email/name seed; "user" if empty. */
export function handleBase(seed: string): string {
  const base = (seed.split("@")[0] || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 14);
  return base.length >= 2 ? base : "user";
}

/** A friendly default display name: the given name, else the email local part. */
export function defaultDisplayName(data: { name?: unknown; email?: unknown }): string {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (name) return name.slice(0, 32);
  const email = typeof data.email === "string" ? data.email : "";
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  if (local) return local.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 32);
  return "New Member";
}

async function isTaken(client: RabbatClient, handle: string): Promise<boolean> {
  // Index-served point lookup on the unique `username` column.
  const row = await client.table("user").where("username", "=", handle).first();
  return row != null;
}

/** A unique `@handle` derived from `seed` (e.g. the email). */
export async function generateUniqueUsername(client: RabbatClient, seed: string): Promise<string> {
  const base = handleBase(seed);
  for (let attempt = 0; attempt < 10; attempt++) {
    const width = attempt < 5 ? 4 : 6;
    let handle = `${base}_${rand(width)}`;
    if (handle.length > 20) handle = handle.slice(0, 20);
    if (!HANDLE_RE.test(handle)) handle = `user_${rand(width)}`;
    if (!(await isTaken(client, handle))) return handle;
  }
  return `user_${rand(12)}`; // astronomically unlikely to collide
}

/**
 * Give a default username + display name to any user missing them. Idempotent:
 * only rows with a null/blank username are touched, so it's safe to run on every
 * startup. Returns how many users were updated.
 */
export async function backfillUserDefaults(client: RabbatClient): Promise<number> {
  const all = (await client.table("user").collect()) as Row[];
  const pending = all.filter((u) => u.username == null || String(u.username).trim() === "");
  let fixed = 0;
  for (const u of pending) {
    const patch: Row = {
      username: await generateUniqueUsername(client, String(u.email ?? u.name ?? u.id)),
    };
    if (typeof u.name !== "string" || !u.name.trim()) patch.name = defaultDisplayName(u);
    await client.patch("user", u.id as string, patch);
    fixed++;
  }
  return fixed;
}
