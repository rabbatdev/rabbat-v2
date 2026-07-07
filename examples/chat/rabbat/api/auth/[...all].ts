// Better Auth, mounted as a Rabbat api route. Every `/api/auth/*` request
// (sign-in, OAuth callback, get-session, sign-out, …) is handled in-process by
// Better Auth's own Web handler — `ctx.request` is the standard Request.
//
// rabbat-v2's `defineServerRoute` takes `{ path, handlers }`; the path is a
// catch-all (Hono `*` wildcard) so every sub-path lands here, and each verb
// forwards to `auth.handler`. Better Auth routes by method internally, so we
// register every method to the same handler.

import { defineRoute } from "rabbat/server";
import { configureServerDb } from "rabbat/functions";
import type { DurableNamespaceLike } from "@rabbat/db";

import { auth } from "../../functions/server.ts";
import { env } from "../../functions/env.ts";

export default defineRoute({
  path: "/api/auth/*",
  handlers: (route) => {
    // Publish the partition DO binding for serverDb (Better Auth's adapter)
    // before handing off — in-edge binding calls avoid the workerd loopback
    // limitation that breaks a Worker fetching its own origin.
    const handler = route.handler((ctx) => {
      configureServerDb({
        namespace: ctx.env.RABBAT_PARTITION as DurableNamespaceLike,
        serviceKey: env.SERVICE_KEY,
      });
      return auth.handler(ctx.request);
    });
    return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
  },
});
