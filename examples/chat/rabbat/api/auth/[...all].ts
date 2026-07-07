// Better Auth, mounted as a Rabbat api route. Every `/api/auth/*` request
// (sign-in, OAuth callback, get-session, sign-out, …) is handled in-process by
// Better Auth's own Web handler — `ctx.request` is the standard Request.
//
// rabbat-v2's `defineServerRoute` takes `{ path, handlers }`; the path is a
// catch-all (Hono `*` wildcard) so every sub-path lands here, and each verb
// forwards to `auth.handler`. Better Auth routes by method internally, so we
// register every method to the same handler.

import { defineRoute } from "rabbat/server";

import { auth } from "../../functions/server.ts";

export default defineRoute({
  path: "/api/auth/*",
  handlers: (route) => {
    // One handler forwards the raw Request to Better Auth for every verb.
    const handler = route.handler((ctx) => auth.handler(ctx.request));
    return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
  },
});
