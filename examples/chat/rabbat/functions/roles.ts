import { v } from "rabbat/functions";

import { mutation, query } from "./setup.ts";
import { newId } from "./util.ts";
import { ALL_PERMS, DEFAULT_ROLE_NAME, orbitContext, Perm, requirePerm } from "./perms.ts";

/** Roles in an orbit, most senior first (members rail + role menus). */
export const list = query({
  args: { orbitId: v.string() },
  handler: (ctx, { orbitId }) =>
    ctx.db.table("roles").where({ orbit_id: orbitId }).order("position", "asc").collect(),
});

export const create = mutation({
  args: { orbitId: v.string(), name: v.string(), color: v.optional(v.string()), permissions: v.optional(v.number()) },
  handler: async (ctx, { orbitId, name, color, permissions }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_ROLES, "you can't manage roles in this orbit");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("role name is empty");
    const existing = await ctx.db.table("roles").where({ orbit_id: orbitId }).collect();
    const id = newId("role");
    await ctx.db.insert("roles", {
      id,
      orbit_id: orbitId,
      name: trimmed,
      permissions: (permissions ?? 0) & ALL_PERMS,
      color: color || null,
      position: existing.length,
      created_at: Date.now(),
    });
    return { id };
  },
});

export const update = mutation({
  args: {
    roleId: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    permissions: v.optional(v.number()),
  },
  handler: async (ctx, { roleId, name, color, permissions }) => {
    const me = ctx.user;
    const role = await ctx.db.get("roles", roleId);
    if (!role) throw new Error("role not found");
    const octx = await orbitContext(ctx.db, role.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_ROLES, "you can't manage roles in this orbit");
    const patch: { name?: string; color?: string | null; permissions?: number } = {};
    if (name !== undefined && name.trim()) patch.name = name.trim();
    if (color !== undefined) patch.color = color || null;
    if (permissions !== undefined) patch.permissions = permissions & ALL_PERMS;
    if (Object.keys(patch).length) await ctx.db.patch("roles", roleId, patch);
  },
});

/** Delete a role; its members fall back to the default Member role. */
export const remove = mutation({
  args: { roleId: v.string() },
  handler: async (ctx, { roleId }) => {
    const me = ctx.user;
    const role = await ctx.db.get("roles", roleId);
    if (!role) return;
    if (role.name === DEFAULT_ROLE_NAME) throw new Error("the default role can't be deleted");
    const octx = await orbitContext(ctx.db, role.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_ROLES, "you can't manage roles in this orbit");
    const fallback = await ctx.db
      .table("roles")
      .where({ orbit_id: role.orbit_id, name: DEFAULT_ROLE_NAME })
      .first();
    const members = await ctx.db.table("members").where({ orbit_id: role.orbit_id }).collect();
    for (const m of members) {
      if (m.role_id === roleId) await ctx.db.patch("members", m.id, { role_id: fallback?.id ?? "" });
    }
    await ctx.db.delete("roles", roleId);
  },
});
