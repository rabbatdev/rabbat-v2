import { defineServerRoute } from "@rabbat/server"
import { tailWindow } from "@rabbat/protocol"
import { api } from "../_generated/api.js"

export default defineServerRoute({
  path: "/api/channels/:channelId/stats",
  handlers: (route) => ({
    // `ctx.params.channelId` is typed from the path; `ctx.runQuery` runs a
    // function with validation + auth, like a Convex action.
    GET: route.handler(async (ctx) => {
      const page = await ctx.runQuery(api.messages.list, {
        channelId: ctx.params.channelId,
        paginationOpts: tailWindow(1),
      })
      return ctx.json({ channelId: ctx.params.channelId, messages: (page as { total: number }).total })
    }),
  }),
})
