// Custom emoji — orbit-scoped uploaded images referenced as `:name:` in message
// bodies and usable as reactions. Creating/deleting needs MANAGE_EMOJI, which is
// owner-only by default (no role carries it unless an owner grants it).

import { v } from "rabbat/functions";

import { mutation, query, publicQuery } from "./setup.ts";
import { newId } from "./util.ts";
import { orbitContext, requirePerm, Perm } from "./perms.ts";

const NAME_RE = /^[a-z0-9_]{2,32}$/;

/** Every custom emoji in one orbit (alphabetical) — drives the settings manager. */
export const list = query({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const rows = await ctx.db.table("custom_emoji").where({ orbit_id: orbitId }).collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Every custom emoji from ALL orbits the caller belongs to — so emoji from one
 *  server can be used (and rendered) anywhere, Discord-style. Carries the source
 *  orbit's name so the picker can group by server. Drives the picker, the
 *  composer atom, and message/reaction rendering. */
export const available = publicQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.identity;
    if (!me) return [];
    const memberships = await ctx.db.table("members").where({ user_id: me.subject }).collect();
    const orbitIds = [...new Set(memberships.map((m) => m.orbit_id))];
    if (orbitIds.length === 0) return [];
    const emojis = await ctx.db.table("custom_emoji").where("orbit_id", "in", orbitIds).collect();
    const orbits = await ctx.db.table("orbits").where("id", "in", orbitIds).collect();
    const orbitName = new Map(orbits.map((o) => [o.id, o.name]));
    return emojis
      .map((e) => ({ id: e.id, name: e.name, url: e.url, orbit_id: e.orbit_id, orbit_name: orbitName.get(e.orbit_id) ?? "Server" }))
      .sort((a, b) => a.orbit_name.localeCompare(b.orbit_name) || a.name.localeCompare(b.name));
  },
});

/** Resolve custom emoji by id for ANY signed-in user — used to render emoji
 *  (in message bodies + reactions) that were posted from a server the viewer
 *  isn't a member of. The image URLs are public, so this isn't gated by
 *  membership; you can only *pick* from your own orbits (see `available`). */
export const byIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const want = [...new Set(ids.filter(Boolean))];
    if (want.length === 0) return [];
    // Fetch exactly the requested emoji by primary key (point lookups) — never a
    // full table scan.
    const rows = await ctx.db.table("custom_emoji").where("id", "in", want).collect();
    return rows.map((e) => ({ id: e.id, name: e.name, url: e.url }));
  },
});

export const create = mutation({
  args: { orbitId: v.string(), name: v.string(), url: v.string() },
  handler: async (ctx, { orbitId, name, url }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_EMOJI, "you don't have permission to manage emoji in this orbit");

    const clean = name.trim().toLowerCase().replace(/^:|:$/g, "");
    if (!NAME_RE.test(clean)) {
      throw new Error("Name must be 2–32 chars: lowercase letters, numbers, or underscores.");
    }
    if (!url) throw new Error("missing image");

    const existing = await ctx.db.table("custom_emoji").where({ orbit_id: orbitId, name: clean }).first();
    if (existing) throw new Error(`:${clean}: already exists in this orbit`);

    const id = newId("emj");
    await ctx.db.insert("custom_emoji", {
      id,
      orbit_id: orbitId,
      name: clean,
      url,
      creator_id: me.subject,
      created_at: Date.now(),
    });
    return { id, name: clean };
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const emoji = await ctx.db.get("custom_emoji", id);
    if (!emoji) return;
    const octx = await orbitContext(ctx.db, emoji.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_EMOJI, "you don't have permission to manage emoji in this orbit");
    await ctx.db.delete("custom_emoji", id);
  },
});
