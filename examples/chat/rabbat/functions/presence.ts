import { v } from "rabbat/functions";

import { mutation, publicQuery } from "./setup.ts";

// The statuses a user can choose. "online" is the automatic one — it shows as
// online while the tab is active and decays to offline once the heartbeat goes
// stale (i.e. you're away). "busy" is do-not-disturb; "invisible" appears
// offline to everyone else.
const CHOOSABLE = new Set(["online", "busy", "invisible"]);

/** Heartbeat — the client calls this every ~20s while the tab is focused, so
 *  presence reflects real activity rather than "online forever". It only bumps
 *  `last_seen`; the chosen status is preserved (new users default to online). */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const me = ctx.user;
    const now = Date.now();
    const existing = await ctx.db.get("presence", me.subject);
    if (existing) {
      await ctx.db.patch("presence", me.subject, { last_seen: now });
    } else {
      await ctx.db.insert("presence", { user_id: me.subject, last_seen: now, status: "online" });
    }
  },
});

/** Set your own status preference: "online" (auto-away), "busy", or "invisible". */
export const setStatus = mutation({
  args: { status: v.string() },
  handler: async (ctx, { status }) => {
    const me = ctx.user;
    const s = CHOOSABLE.has(status) ? status : "online";
    const now = Date.now();
    const existing = await ctx.db.get("presence", me.subject);
    if (existing) {
      await ctx.db.patch("presence", me.subject, { status: s, last_seen: now });
    } else {
      await ctx.db.insert("presence", { user_id: me.subject, last_seen: now, status: s });
    }
  },
});

/** The signed-in user's own chosen status — including "invisible", which the
 *  members list masks as offline for everyone else but the rail shows as-is. */
export const me = publicQuery({
  args: {},
  handler: async (ctx) => {
    const id = ctx.identity;
    if (!id) return { status: "online" };
    const pres = await ctx.db.get("presence", id.subject);
    return { status: pres?.status ?? "online" };
  },
});
