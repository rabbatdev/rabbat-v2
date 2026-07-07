import { v } from "rabbat/functions";

import { mutation, query } from "./setup.ts";
import { newId } from "./util.ts";
import { canSendInChannel, canViewChannel, orbitContext, Perm, requirePerm } from "./perms.ts";

/** Channels in an orbit the caller may see, ordered (the sidebar groups them). */
export const list = query({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    const chans = await ctx.db
      .table("channels")
      .where({ orbit_id: orbitId })
      .order("position", "asc")
      .collect();
    return chans.filter((c) => canViewChannel(c, octx));
  },
});

/** A single channel (chat header) + whether the caller can post in it. Returns
 *  null if the caller isn't allowed to view it. */
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const channel = await ctx.db.get("channels", id);
    if (!channel) return null;
    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    if (!canViewChannel(channel, octx)) return null;
    return { ...channel, canSend: canSendInChannel(channel, octx) };
  },
});

export const create = mutation({
  args: {
    orbitId: v.string(),
    name: v.string(),
    categoryId: v.optional(v.string()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, { orbitId, name, categoryId, topic }) => {
    const me = ctx.user;
    const octx = await orbitContext(ctx.db, orbitId, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't create channels in this orbit");
    const trimmed = name.trim().replace(/\s+/g, "-").toLowerCase();
    if (!trimmed) throw new Error("channel name is empty");
    const siblings = await ctx.db.table("channels").where({ orbit_id: orbitId }).collect();
    const id = newId("chan");
    await ctx.db.insert("channels", {
      id,
      orbit_id: orbitId,
      category_id: categoryId ?? null,
      name: trimmed,
      topic: topic?.trim() || null,
      position: siblings.length,
      created_at: Date.now(),
    });
    return { id };
  },
});

/** Rename / re-topic / re-categorize a channel and set view/send role overrides
 *  (needs MANAGE_CHANNELS). `viewRoles`/`sendRoles` are role-id arrays; an empty
 *  array clears the restriction (everyone). */
export const update = mutation({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    topic: v.optional(v.string()),
    categoryId: v.optional(v.string()),
    viewRoles: v.optional(v.array(v.string())),
    sendRoles: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, name, topic, categoryId, viewRoles, sendRoles }) => {
    const me = ctx.user;
    const channel = await ctx.db.get("channels", id);
    if (!channel) throw new Error("channel not found");
    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    const patch: {
      name?: string;
      topic?: string | null;
      category_id?: string | null;
      view_roles?: string | null;
      send_roles?: string | null;
    } = {};
    if (name !== undefined) {
      const n = name.trim().replace(/\s+/g, "-").toLowerCase();
      if (n) patch.name = n;
    }
    if (topic !== undefined) patch.topic = topic.trim() || null;
    if (categoryId !== undefined) patch.category_id = categoryId || null;
    if (viewRoles !== undefined) patch.view_roles = viewRoles.length ? viewRoles.join(",") : null;
    if (sendRoles !== undefined) patch.send_roles = sendRoles.length ? sendRoles.join(",") : null;
    if (Object.keys(patch).length) await ctx.db.patch("channels", id, patch);
  },
});

/** Drag-and-drop reorder: place `channelId` into `categoryId` (omit/empty for no
 *  category) and renumber that group. `orderedIds` is the target group's full,
 *  post-move channel order (including the dragged channel). Handles both
 *  reordering within a category and moving a channel between categories. */
export const reorder = mutation({
  args: {
    channelId: v.string(),
    categoryId: v.optional(v.string()),
    orderedIds: v.array(v.string()),
  },
  handler: async (ctx, { channelId, categoryId, orderedIds }) => {
    const me = ctx.user;
    const channel = await ctx.db.get("channels", channelId);
    if (!channel) throw new Error("channel not found");
    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't manage channels in this orbit");
    const catId = categoryId || null;
    // Renumber the target group; positions are per-orbit but the sidebar groups
    // by category, so monotonic positions within each group are all that matter.
    for (let i = 0; i < orderedIds.length; i++) {
      const ch = await ctx.db.get("channels", orderedIds[i]);
      if (!ch || ch.orbit_id !== channel.orbit_id) continue;
      const patch: { category_id?: string | null; position?: number } = {};
      if (ch.category_id !== catId) patch.category_id = catId;
      if (ch.position !== i) patch.position = i;
      if (Object.keys(patch).length) await ctx.db.patch("channels", orderedIds[i], patch);
    }
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const channel = await ctx.db.get("channels", id);
    if (!channel) return;
    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    requirePerm(octx, Perm.MANAGE_CHANNELS, "you can't delete channels in this orbit");
    const msgs = await ctx.db.table("messages").where({ channel_id: id }).collect();
    for (const m of msgs) await ctx.db.delete("messages", m.id);
    await ctx.db.delete("channels", id);
  },
});
