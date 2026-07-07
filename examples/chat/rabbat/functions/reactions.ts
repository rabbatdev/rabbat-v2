// Message reactions — one row per (user, message, emoji). `emoji` is either a
// unicode grapheme or "custom:<emojiId>". A single `toggle` adds the reaction if
// you haven't used it on that message, or removes it if you have. Reactions are
// read back through messages.list (aggregated per message), not a query here.

import { v } from "rabbat/functions";

import { mutation } from "./setup.ts";
import { newId } from "./util.ts";
import { canViewChannel, orbitContext } from "./perms.ts";

export const toggle = mutation({
  args: { messageId: v.string(), emoji: v.string() },
  handler: async (ctx, { messageId, emoji }) => {
    const me = ctx.user;
    const value = emoji.trim();
    if (!value) throw new Error("missing emoji");

    const message = await ctx.db.get("messages", messageId);
    if (!message) throw new Error("message not found");
    const channel = await ctx.db.get("channels", message.channel_id);
    if (!channel) throw new Error("channel not found");

    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    if (!octx.isMember) throw new Error("you are not a member of this orbit");
    if (!canViewChannel(channel, octx)) throw new Error("you can't react in this channel");

    const existing = await ctx.db
      .table("reactions")
      .where({ message_id: messageId, user_id: me.subject, emoji: value })
      .first();

    if (existing) {
      await ctx.db.delete("reactions", existing.id);
      return { reacted: false };
    }
    await ctx.db.insert("reactions", {
      id: newId("rxn"),
      message_id: messageId,
      channel_id: message.channel_id,
      user_id: me.subject,
      emoji: value,
      created_at: Date.now(),
    });
    return { reacted: true };
  },
});
