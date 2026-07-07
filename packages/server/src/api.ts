import { Hono } from "hono"
import type { ServerContext, ServerRouteDef } from "@rabbat/router"
import type { Identity } from "@rabbat/functions"

export interface ApiDeps {
  auth: (token: string | null) => Identity | null | Promise<Identity | null>
  /** Proxy a call to the owning partition Durable Object (the request's token carries identity). */
  call: (
    kind: "query" | "mutation" | "action",
    name: string,
    args: Record<string, unknown>,
    token: string | null,
  ) => Promise<unknown>
  env: Record<string, unknown>
}

function tokenOf(request: Request): string | null {
  const auth = request.headers.get("Authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)
  return new URL(request.url).searchParams.get("token")
}

/**
 * Build a Hono app from `defineServerRoute` definitions (rabbat v1 used Hono too).
 * Each handler runs its typed middleware chain (which can extend the context),
 * then the handler — with `ctx.runQuery`/`runMutation`/`runAction` proxying to the
 * partition like a Convex action (validation + auth always run).
 */
export function createApiApp(routes: ReadonlyArray<ServerRouteDef>, deps: ApiDeps): Hono {
  const app = new Hono()
  for (const route of routes) {
    for (const method of Object.keys(route.handlers) as Array<keyof typeof route.handlers>) {
      const spec = route.handlers[method]
      if (!spec) continue
      app.on(method, route.path, async (c) => {
        const token = tokenOf(c.req.raw)
        const identity = await deps.auth(token)
        const base: ServerContext = {
          request: c.req.raw,
          params: c.req.param() as Record<string, string>,
          identity,
          env: deps.env,
          runQuery: (ref, args) => deps.call("query", ref.name, args as Record<string, unknown>, token) as never,
          runMutation: (ref, args) => deps.call("mutation", ref.name, args as Record<string, unknown>, token) as never,
          runAction: (ref, args) => deps.call("action", ref.name, args as Record<string, unknown>, token) as never,
          json: (data, init) => Response.json(data, init),
          text: (body, init) => new Response(body, init),
        }
        let ctx: ServerContext = base
        for (const mw of spec.middleware) {
          const out = await mw(ctx)
          if (out instanceof Response) return out
          if (out && typeof out === "object") ctx = { ...ctx, ...(out as object) } as ServerContext
        }
        const result = await spec.run(ctx)
        return result instanceof Response ? result : Response.json(result ?? null)
      })
    }
  }
  return app
}
