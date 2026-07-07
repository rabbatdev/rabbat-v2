import { v } from "rabbat/functions";

import { mutation, query } from "./setup.ts";
import { newId } from "./util.ts";
import { orbitContext, Perm, requirePerm } from "./perms.ts";

/** Categories in an orbit, ordered. */
export const list = query({
  args: { orbitId: v.string() },
  handler: (ctx, { orbitId }) =>
    ctx.db.table("categories").where({ orbit_id: orbitId }).order("position", "asc").collect(),
});

export const create = mutation({
  args: { orbitId: v.string(), name: v.string() },
  handler: async (ctx, { orbitId, name }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("category name is empty");
    const existing = await ctx.db.table("categories").where({ orbit_id: orbitId }).collect();
    const id = newId("cat");
    await ctx.db.insert("categories", {
      id,
      orbit_id: orbitId,
      name: trimmed,
      position: existing.length,
    });
    return { id };
  },
});

/** Rename a category (name only — categories carry no permissions). */
export const update = mutation({
  args: { categoryId: v.string(), name: v.string() },
  handler: async (ctx, { categoryId, name }) => {
    const me = ctx.user;
    const cat = await ctx.db.get("categories", categoryId);
    if (!cat) throw new Error("category not found");
    const octx = await orbitContext(ctx.db, cat.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("category name is empty");
    await ctx.db.patch("categories", categoryId, { name: trimmed });
  },
});

/** Persist a new category order. `orderedIds` is the full list of category ids
 *  in their desired order; each gets its index as its position. */
export const reorder = mutation({
  args: { orbitId: v.string(), orderedIds: v.array(v.string()) },
  handler: async (ctx, { orbitId, orderedIds }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    for (let i = 0; i < orderedIds.length; i++) {
      const cat = await ctx.db.get("categories", orderedIds[i]);
      if (!cat || cat.orbit_id !== orbitId) continue;
      if (cat.position !== i) await ctx.db.patch("categories", orderedIds[i], { position: i });
    }
  },
});

/** Delete a category; its channels fall back to "uncategorized" (not deleted). */
export const remove = mutation({
  args: { orbitId: v.string(), categoryId: v.string() },
  handler: async (ctx, { orbitId, categoryId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    // Filter by the indexed `orbit_id` (an orbit has only a handful of channels)
    // and narrow to the category in memory — `category_id` isn't indexed, so a
    // direct `where({ category_id })` would be a full table scan.
    const channels = (await ctx.db.table("channels").where({ orbit_id: orbitId }).collect()).filter(
      (ch) => ch.category_id === categoryId,
    );
    for (const ch of channels) await ctx.db.patch("channels", ch.id, { category_id: null });
    await ctx.db.delete("categories", categoryId);
  },
});
