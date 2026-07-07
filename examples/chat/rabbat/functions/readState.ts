import { v } from "rabbat/functions";

import { mutation, publicQuery } from "./setup.ts";
import { newId } from "./util.ts";

/** Per-channel unread state for the current user across an orbit. A channel is
 *  unread when its newest message is newer than the user's last read mark
 *  (which defaults to when they joined, so pre-join history isn't "unread").
 *  Reactive: new messages or read marks re-run it and update the badges. */
export const unread = publicQuery({
  args: { orbitId: v.string() },
  handler: async (ctx, { orbitId }) => {
    const me = ctx.identity;
    if (!me) return {} as Record<string, { unread: boolean; count: number }>;
    const member = await ctx.db
      .table("members")
      .where({ orbit_id: orbitId, user_id: me.subject })
      .first();
    const joinedAt = member?.joined_at ?? 0;
    const reads = await ctx.db.table("read_state").where({ user_id: me.subject }).collect();
    const readBy = new Map(reads.map((r) => [r.channel_id, r.last_read_at]));
    const channels = await ctx.db.table("channels").where({ orbit_id: orbitId }).collect();

    const out: Record<string, { unread: boolean; count: number }> = {};
    for (const ch of channels) {
      const lastRead = Math.max(readBy.get(ch.id) ?? 0, joinedAt);
      const fresh = await ctx.db
        .table("messages")
        .where({ channel_id: ch.id })
        .where("created_at", ">", lastRead)
        // Your own messages are never "unread" to you — and excluding them here
        // also means sending a message doesn't re-trigger this subscription (the
        // new row doesn't match the filter), so the badge never flickers on.
        .where("author_id", "!=", me.subject)
        .collect();
      out[ch.id] = { unread: fresh.length > 0, count: fresh.length };
    }
    return out;
  },
});

/** Mark a channel read up to now. */
export const markRead = mutation({
  args: { channelId: v.string() },
  handler: async (ctx, { channelId }) => {
    const me = ctx.user;
    const now = Date.now();
    const existing = await ctx.db
      .table("read_state")
      .where({ user_id: me.subject, channel_id: channelId })
      .first();
    if (existing) {
      await ctx.db.patch("read_state", existing.id, { last_read_at: now });
    } else {
      await ctx.db.insert("read_state", {
        id: newId("read"),
        user_id: me.subject,
        channel_id: channelId,
        last_read_at: now,
      });
    }
  },
});
