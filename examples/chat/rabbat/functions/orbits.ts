import { v } from "rabbat/functions";

import { mutation, query, publicQuery } from "./setup.ts";
import { isInviteLive, newId, newInviteCode } from "./util.ts";
import { DEFAULT_ROLES, DEFAULT_ROLE_NAME, orbitContext, Perm, requirePerm } from "./perms.ts";

function hueFrom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** Orbits the signed-in user belongs to, oldest first (for the left rail). */
export const listMine = publicQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.identity;
    if (!me) return [];
    const mems = await ctx.db.table("members").where({ user_id: me.subject }).collect();
    const orbits = await Promise.all(mems.map((m) => ctx.db.get("orbits", m.orbit_id)));
    return orbits
      .filter((o): o is NonNullable<typeof o> => !!o)
      .sort((a, b) => a.created_at - b.created_at);
  },
});

/** A single orbit + the caller's standing in it. */
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const orbit = await ctx.db.get("orbits", id);
    if (!orbit) return null;
    const octx = await orbitContext(ctx.db, id, me.subject);
    if (!octx.isMember) return null;
    return {
      ...orbit,
      isOwner: octx.isOwner,
      permissions: octx.permissions,
      roleId: octx.roleId,
    };
  },
});

/** Public preview of an orbit by invite code — works for non-members so the
 *  invite-accept page can show what you're joining. Null = invalid/expired/used-up. */
export const byInvite = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const me = ctx.user;
    const inv = await ctx.db.get("invites", code.trim());
    if (!inv || !isInviteLive(inv, Date.now())) return null;
    const orbit = await ctx.db.get("orbits", inv.orbit_id);
    if (!orbit) return null;
    const members = await ctx.db.table("members").where({ orbit_id: orbit.id }).collect();
    return {
      id: orbit.id,
      name: orbit.name,
      icon: orbit.icon ?? null,
      cover: orbit.cover ?? null,
      hue: orbit.hue,
      memberCount: members.length,
      alreadyMember: members.some((m) => m.user_id === me.subject),
    };
  },
});

/** Create an orbit: owner membership, default roles, a starter category + channels. */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const me = ctx.user;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("orbit name is empty");
    const orbitId = newId("orbit");
    const now = Date.now();
    await ctx.db.insert("orbits", {
      id: orbitId,
      name: trimmed,
      invite: null, // legacy column; invite links now live in the `invites` table
      hue: hueFrom(orbitId),
      icon: null,
      cover: null,
      owner_id: me.subject,
      created_at: now,
    });

    // A default, never-expiring invite link so the orbit is immediately shareable.
    await ctx.db.insert("invites", {
      id: newInviteCode(),
      orbit_id: orbitId,
      creator_id: me.subject,
      expires_at: null,
      max_uses: null,
      uses: 0,
      created_at: now,
    });

    let memberRoleId = "";
    for (const r of DEFAULT_ROLES) {
      const roleId = newId("role");
      if (r.name === DEFAULT_ROLE_NAME) memberRoleId = roleId;
      await ctx.db.insert("roles", {
        id: roleId,
        orbit_id: orbitId,
        name: r.name,
        permissions: r.permissions,
        color: r.color,
        position: r.position,
        created_at: now,
      });
    }
    await ctx.db.insert("members", {
      id: newId("mem"),
      orbit_id: orbitId,
      user_id: me.subject,
      role_id: memberRoleId,
      joined_at: now,
    });

    const catId = newId("cat");
    await ctx.db.insert("categories", { id: catId, orbit_id: orbitId, name: "General", position: 0 });
    const starters = ["general", "random"];
    for (let i = 0; i < starters.length; i++) {
      await ctx.db.insert("channels", {
        id: newId("chan"),
        orbit_id: orbitId,
        category_id: catId,
        name: starters[i],
        topic: i === 0 ? "Welcome to your new orbit 👋" : null,
        position: i,
        created_at: now,
      });
    }
    return { id: orbitId };
  },
});

/** Update an orbit's name / icon / cover (needs MANAGE_ORBIT). */
export const update = mutation({
  args: {
    orbitId: v.string(),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    cover: v.optional(v.string()),
  },
  handler: async (ctx, { orbitId, name, icon, cover }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_ORBIT, "you can't manage this orbit");
    const patch: { name?: string; icon?: string | null; cover?: string | null } = {};
    if (name !== undefined && name.trim()) patch.name = name.trim();
    if (icon !== undefined) patch.icon = icon || null;
    if (cover !== undefined) patch.cover = cover || null;
    if (Object.keys(patch).length) await ctx.db.patch("orbits", orbitId, patch);
  },
});

/** Join an orbit via an invite link. Validates the invite (exists, not expired,
 *  not used-up) and counts the use when a new member joins. */
export const join = mutation({
  args: { invite: v.string() },
  handler: async (ctx, { invite }) => {
    const me = ctx.user;
    const now = Date.now();
    const inv = await ctx.db.get("invites", invite.trim());
    if (!inv) throw new Error("that invite link is invalid");
    if (inv.expires_at != null && inv.expires_at <= now) throw new Error("that invite link has expired");
    if (inv.max_uses != null && inv.uses >= inv.max_uses) throw new Error("that invite link has reached its limit");
    const orbit = await ctx.db.get("orbits", inv.orbit_id);
    if (!orbit) throw new Error("that orbit no longer exists");
    const existing = await ctx.db
      .table("members")
      .where({ orbit_id: orbit.id, user_id: me.subject })
      .first();
    if (existing) return { id: orbit.id };
    const memberRole = await ctx.db
      .table("roles")
      .where({ orbit_id: orbit.id, name: DEFAULT_ROLE_NAME })
      .first();
    await ctx.db.insert("members", {
      id: newId("mem"),
      orbit_id: orbit.id,
      user_id: me.subject,
      role_id: memberRole?.id ?? "",
      joined_at: now,
    });
    await ctx.db.patch("invites", inv.id, { uses: inv.uses + 1 });
    return { id: orbit.id };
  },
});

/** Leave an orbit (owners can't leave — they delete it instead). */
export const leave = mutation({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const me = ctx.user;
    const orbit = await ctx.db.get("orbits", orbitId);
    if (!orbit) return;
    if (orbit.owner_id === me.subject) throw new Error("the owner can't leave; delete the orbit instead");
    const member = await ctx.db.table("members").where({ orbit_id: orbitId, user_id: me.subject }).first();
    if (member) await ctx.db.delete("members", member.id);
  },
});

/** Delete an orbit and all of its content (owner only). */
export const remove = mutation({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    if (!octx.isOwner) throw new Error("only the owner can delete an orbit");
    requirePerm(octx, Perm.MANAGE_ORBIT, "missing permission");
    const channels = await ctx.db.table("channels").where({ orbit_id: orbitId }).collect();
    for (const ch of channels) {
      const msgs = await ctx.db.table("messages").where({ channel_id: ch.id }).collect();
      for (const m of msgs) await ctx.db.delete("messages", m.id);
      await ctx.db.delete("channels", ch.id);
    }
    for (const t of ["categories", "members", "roles", "invites"] as const) {
      const rows = await ctx.db.table(t).where({ orbit_id: orbitId }).collect();
      for (const r of rows) await ctx.db.delete(t, r.id);
    }
    await ctx.db.delete("orbits", orbitId);
  },
});
