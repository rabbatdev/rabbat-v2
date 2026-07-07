import type { ArgsOf, FunctionReference, Identity, ReturnOf } from "@rabbat/functions"
import type { PathParams } from "./params.js"

/**
 * The context an API-route handler runs in. Like a Convex action there's no
 * direct `db`; go through `runQuery`/`runMutation`/`runAction` so validation and
 * auth always run. Middleware extends this context (and its type).
 */
export interface ServerContext {
  readonly request: Request
  readonly params: Record<string, string>
  readonly identity: Identity | null
  readonly env: Record<string, unknown>
  runQuery<R extends FunctionReference<"query", any, any>>(ref: R, args: ArgsOf<R>): Promise<ReturnOf<R>>
  runMutation<R extends FunctionReference<"mutation", any, any>>(ref: R, args: ArgsOf<R>): Promise<ReturnOf<R>>
  runAction<R extends FunctionReference<"action", any, any>>(ref: R, args: ArgsOf<R>): Promise<ReturnOf<R>>
  json(data: unknown, init?: ResponseInit): Response
  text(body: string, init?: ResponseInit): Response
}

/** A middleware returns fields to merge into the context (typed), or a Response to short-circuit. */
export type ServerMiddleware<In, Out extends object> = (ctx: In) => Out | Response | Promise<Out | Response>

export interface CompiledHandler {
  readonly middleware: ReadonlyArray<(ctx: ServerContext) => unknown>
  readonly run: (ctx: ServerContext) => unknown
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * A typed handler builder. Each `.use(mw)` widens the context type by the
 * middleware's return, so `.handler` sees the accumulated context — `ctx.user`
 * appears only after a `.use(auth)` that returns `{ user }`.
 */
export class HandlerBuilder<Ctx extends ServerContext> {
  constructor(private readonly mws: ReadonlyArray<(ctx: ServerContext) => unknown> = []) {}

  use<Out extends object>(mw: ServerMiddleware<Ctx, Out>): HandlerBuilder<Ctx & Out> {
    return new HandlerBuilder<Ctx & Out>([...this.mws, mw as (ctx: ServerContext) => unknown])
  }

  handler(run: (ctx: Ctx) => Response | Promise<Response> | unknown): CompiledHandler {
    return { middleware: this.mws, run: run as (ctx: ServerContext) => unknown }
  }
}

export interface ServerRouteDef {
  readonly path: string
  readonly handlers: Partial<Record<HttpMethod, CompiledHandler>>
}

/**
 * Define an API route, handled by Hono in the Worker.
 *
 * ```ts
 * export default defineServerRoute({
 *   path: "/api/channels/:channelId/export",
 *   handlers: (route) => ({
 *     GET: route
 *       .use(requireAuth)                         // ctx gains { user }
 *       .handler(async (ctx) =>
 *         ctx.json(await ctx.runQuery(api.messages.list, { channelId: ctx.params.channelId }))),
 *   }),
 * })
 * ```
 */
export function defineServerRoute<const Path extends string>(config: {
  path: Path
  handlers: (
    route: HandlerBuilder<ServerContext & { params: PathParams<Path> }>,
  ) => Partial<Record<HttpMethod, CompiledHandler>>
}): ServerRouteDef {
  return { path: config.path, handlers: config.handlers(new HandlerBuilder()) }
}
