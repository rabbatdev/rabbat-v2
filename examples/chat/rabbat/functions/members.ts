import { v } from "rabbat/functions";

import { mutation, query } from "./setup.ts";
import { orbitContext, Perm, requirePerm } from "./perms.ts";

const ONLINE_WINDOW_MS = 45_000;

/** Orbit members with profile, role, and live presence (for the members rail). */
export const list = query({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const orbit = await ctx.db.get("orbits", orbitId);
    const mems = await ctx.db.table("members").where({ orbit_id: orbitId }).collect();
    const roles = await ctx.db.table("roles").where({ orbit_id: orbitId }).collect();
    const roleById = new Map(roles.map((r) => [r.id, r]));
    // Batch the per-member profile + presence lookups into two `in` queries, so
    // this stays a handful of subscriptions even for a large orbit.
    const userIds = mems.map((m) => m.user_id);
    const users = userIds.length ? await ctx.db.table("user").where("id", "in", userIds).collect() : [];
    const presence = userIds.length
      ? await ctx.db.table("presence").where("user_id", "in", userIds).collect()
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const presById = new Map(presence.map((p) => [p.user_id, p]));
    const now = Date.now();
    return mems.map((m) => {
      const u = userById.get(m.user_id);
      const pres = presById.get(m.user_id);
      const isOwner = orbit?.owner_id === m.user_id;
        const role = roleById.get(m.role_id);
        // The chosen status decays to offline once the heartbeat is stale, and
        // "invisible" reads as offline to everyone but the user themselves.
        const chosen = pres?.status ?? "online";
        const fresh = !!pres && now - pres.last_seen < ONLINE_WINDOW_MS;
        const present = fresh && chosen !== "invisible";
        return {
          userId: m.user_id,
          name: u?.name ?? "unknown",
          username: u?.username ?? null,
          image: u?.image ?? null,
          cover: u?.cover ?? null,
          accent: u?.accent ?? null,
          bio: u?.bio ?? null,
          roleId: m.role_id,
          roleName: isOwner ? "Owner" : (role?.name ?? "Member"),
          roleColor: isOwner ? "45" : (role?.color ?? null),
          rolePosition: isOwner ? -1 : (role?.position ?? 99),
          isOwner,
          online: present,
          status: present ? chosen : "offline",
        };
    });
  },
});

/** Change a member's role (needs MANAGE_ROLES). The owner's role can't change. */
export const setRole = mutation({
  args: { orbitId: v.string(), userId: v.string(), roleId: v.string() },
  handler: async (ctx, { orbitId, userId, roleId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_ROLES, "you can't manage roles in this orbit");
    const orbit = await ctx.db.get("orbits", orbitId);
    if (orbit?.owner_id === userId) throw new Error("the owner's role is fixed");
    const role = await ctx.db.get("roles", roleId);
    if (!role || role.orbit_id !== orbitId) throw new Error("unknown role");
    const member = await ctx.db.table("members").where({ orbit_id: orbitId, user_id: userId }).first();
    if (!member) throw new Error("not a member");
    await ctx.db.patch("members", member.id, { role_id: roleId });
  },
});

/** Remove a member (needs KICK_MEMBERS). Can't kick the owner or yourself. */
export const kick = mutation({
  args: { orbitId: v.string(), userId: v.string() },
  handler: async (ctx, { orbitId, userId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.KICK_MEMBERS, "you can't kick members in this orbit");
    const orbit = await ctx.db.get("orbits", orbitId);
    if (orbit?.owner_id === userId) throw new Error("can't kick the owner");
    if (userId === me.subject) throw new Error("use Leave instead");
    const member = await ctx.db.table("members").where({ orbit_id: orbitId, user_id: userId }).first();
    if (member) await ctx.db.delete("members", member.id);
  },
});
