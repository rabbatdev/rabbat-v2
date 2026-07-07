import { v } from "rabbat/functions";

import { mutation, query, publicQuery } from "./setup.ts";
import { isInviteLive, newInviteCode } from "./util.ts";
import { can, orbitContext, Perm, requirePerm } from "./perms.ts";

/** Public (no auth) — the orbit name behind an invite code, for link unfurls /
 *  OG previews on /invite/<code>. Built with `publicQuery` so a crawler with no
 *  session can read it; only the orbit name is exposed. */
export const meta = publicQuery({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const invite = await ctx.db.get("invites", code);
    // Only describe a CURRENTLY-USABLE invite (matches join validity) — don't
    // disclose the orbit name behind an expired / used-up link.
    if (!invite || !isInviteLive(invite, Date.now())) return { orbitName: null };
    const orbit = await ctx.db.get("orbits", invite.orbit_id);
    return { orbitName: orbit?.name ?? null };
  },
});

/** Active invite links for an orbit (needs CREATE_INVITE to see / manage them). */
export const list = query({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    if (!can(octx, Perm.CREATE_INVITE)) return [];
    const now = Date.now();
    const rows = await ctx.db.table("invites").where({ orbit_id: orbitId }).collect();
    return rows.filter((r) => isInviteLive(r, now)).sort((a, b) => b.created_at - a.created_at);
  },
});

/** Create an invite link. `expiresIn` is seconds (0/undefined = never); `maxUses`
 *  0/undefined = unlimited. Needs the CREATE_INVITE permission. */
export const create = mutation({
  args: { orbitId: v.string(), expiresIn: v.optional(v.number()), maxUses: v.optional(v.number()) },
  handler: async (ctx, { orbitId, expiresIn, maxUses }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.CREATE_INVITE, "you don't have permission to create invites here");
    const now = Date.now();
    let id = newInviteCode();
    while (await ctx.db.get("invites", id)) id = newInviteCode();
    await ctx.db.insert("invites", {
      id,
      orbit_id: orbitId,
      creator_id: me.subject,
      expires_at: expiresIn && expiresIn > 0 ? now + expiresIn * 1000 : null,
      max_uses: maxUses && maxUses > 0 ? maxUses : null,
      uses: 0,
      created_at: now,
    });
    return { code: id };
  },
});

/** Revoke an invite (its creator, or anyone who can manage the orbit). */
export const revoke = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const inv = await ctx.db.get("invites", id);
    if (!inv) return;
    const octx = await orbitContext(ctx.db, inv.orbit_id, me.subject);
    if (inv.creator_id !== me.subject && !can(octx, Perm.MANAGE_ORBIT)) {
      throw new Error("you can't revoke this invite");
    }
    await ctx.db.delete("invites", id);
  },
});
