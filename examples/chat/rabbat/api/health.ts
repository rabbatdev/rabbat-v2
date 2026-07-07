import { defineServerRoute } from "@rabbat/server"

// A middleware that *extends the context type* — `ctx.requestId` only exists in
// handlers that `.use(withRequestId)`.
const withRequestId = () => ({ requestId: crypto.randomUUID() })

export default defineServerRoute({
  path: "/api/health",
  handlers: (route) => ({
    GET: route
      .use(withRequestId)
      .handler((ctx) => ctx.json({ ok: true, requestId: ctx.requestId, identity: ctx.identity })),
  }),
})
