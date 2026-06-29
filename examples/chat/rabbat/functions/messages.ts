import { paginationOpts, v } from "@rabbat/functions"
import { mutation, query } from "./setup.js"

/** A live, bi-directional page of a channel's messages (oldest→newest). */
export const list = query({
  args: { channelId: v.string(), paginationOpts },
  handler: (ctx, { channelId, paginationOpts }) =>
    ctx.db
      .table("messages")
      .where("channel_id", "=", channelId)
      .order("created_at", "asc")
      .paginate(paginationOpts),
})

/** Post a message. The reactive engine streams it to every live `list` window. */
export const send = mutation({
  args: { channelId: v.string(), author: v.string(), body: v.string() },
  handler: async (ctx, { channelId, author, body }) => {
    const id = `msg-${crypto.randomUUID()}`
    await ctx.db.insert("messages", {
      id,
      channel_id: channelId,
      author,
      body,
      created_at: Date.now(),
    })
    return { id }
  },
})

/** Edit a message's body — diffs out as a single upsert to live windows. */
export const edit = mutation({
  args: { id: v.string(), body: v.string() },
  handler: async (ctx, { id, body }) => {
    await ctx.db.patch("messages", id, { body })
  },
})
