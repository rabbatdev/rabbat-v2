import { paginationOpts, v } from "rabbat/functions";

import { mutation, query, publicQuery, type DataModel } from "./setup.ts";

type UserRow = DataModel["user"]["row"];

/** The signed-in user's inbox — newest first, paginated for infinite scroll. */
export const list = query({
  args: { paginationOpts },
  handler: async (ctx, { paginationOpts }) => {
    const me = ctx.user;
    const page = await ctx.db
      .table("notifications")
      .where({ user_id: me.subject })
      .order("created_at", "desc")
      .paginate(paginationOpts);

    const actorIds = [...new Set(page.page.map((n) => n.actor_id))];
    const actors = actorIds.length
      ? ((await ctx.db.table("user").where("id", "in", actorIds).collect()) as UserRow[])
      : [];
    const actorById = new Map(actors.map((u) => [u.id, u]));
    const chanIds = [...new Set(page.page.map((n) => n.channel_id))];
    const chans = chanIds.length
      ? await ctx.db.table("channels").where("id", "in", chanIds).collect()
      : [];
    const chanById = new Map(chans.map((c) => [c.id, c]));

    const enriched = page.page.map((n) => {
      const a = actorById.get(n.actor_id);
      return {
        ...n,
        actor_name: a?.name ?? "Someone",
        actor_image: a?.image ?? null,
        actor_accent: a?.accent ?? null,
        channel_name: chanById.get(n.channel_id)?.name ?? "channel",
      };
    });
    return { ...page, page: enriched };
  },
});

/** Unread count for the bell badge (only unread rows are scanned). */
export const unread = publicQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.identity;
    if (!me) return { count: 0 };
    const rows = await ctx.db
      .table("notifications")
      .where({ user_id: me.subject })
      .where("read", "!=", true)
      .collect();
    return { count: rows.length };
  },
});

/** Mark one notification read (on click / jump). */
export const markRead = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const n = await ctx.db.get("notifications", id);
    if (!n || n.user_id !== me.subject) return;
    if (n.read !== true) await ctx.db.patch("notifications", id, { read: true });
  },
});

/** Mark every unread notification read. */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = ctx.user;
    const rows = await ctx.db
      .table("notifications")
      .where({ user_id: me.subject })
      .where("read", "!=", true)
      .collect();
    for (const r of rows) await ctx.db.patch("notifications", r.id, { read: true });
  },
});
