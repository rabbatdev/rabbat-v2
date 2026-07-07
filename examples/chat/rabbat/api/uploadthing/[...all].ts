// UploadThing, mounted as a Rabbat api route. The handler is a standard Web
// `Request => Response`, so it drops straight in — no Node↔Web conversion. The
// uploader is authenticated in-process by the router's middleware (see
// functions/server.ts). Returns 503 when UPLOADTHING_TOKEN is unset.
//
// rabbat-v2's `defineServerRoute` takes `{ path, handlers }`; the path is a
// catch-all (Hono `*` wildcard). UploadThing handles its own method routing, so
// every verb forwards to the same route handler.

import { defineRoute } from "rabbat/server";

import { uploadHandler } from "../../functions/server.ts";

export default defineRoute({
  path: "/api/uploadthing/*",
  handlers: (route) => {
    const handler = route.handler((ctx) =>
      uploadHandler ? uploadHandler(ctx.request) : ctx.text("uploads disabled", { status: 503 }),
    );
    return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
  },
});
