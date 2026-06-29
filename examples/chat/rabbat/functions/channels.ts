import { v } from "@rabbat/functions"
import { mutation, query } from "./setup.js"

/** A reactive whole-value query: the channel list (re-sent only when it changes). */
export const list = query({
  args: {},
  handler: (ctx) => ctx.db.table("channels").order("created_at", "asc").collect(),
})

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const id = `chan-${name}`
    await ctx.db.insert("channels", { id, name, created_at: Date.now() })
    return { id }
  },
})
