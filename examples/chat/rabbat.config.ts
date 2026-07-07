// "en" chat — Rabbat framework config.
//
// The framework host serves the pages/, the api routes (api/), and the reactive
// /functions WebSocket on one port. Better Auth and UploadThing are plain api
// routes (api/auth, api/uploadthing); their wiring + this app's env live in
// functions/server.ts + functions/env.ts. So this file is just:
//   • auth — resolve a /functions connection's identity (in-process)
//   • meta — the app's default page metadata (Open Graph / Twitter / title)
//
// Per-route pages override `meta` via their own `meta` export — see
// pages/invite/[code].server.ts, which unfurls a shared invite link with the
// orbit's name. The framework injects the resolved <head> tags during SSR; no
// manual <meta> plumbing or HTML string-replacement.
//
// There is NO global auth middleware: functions are public by default, and the
// app opts into auth per-function via the `query`/`mutation` (authed) builders in
// functions/setup.ts — see Convex-style customQuery. `auth` here just makes the
// signed-in identity available to those builders as `ctx.identity` / `ctx.user`.

import { defineConfig } from "rabbat/config";

import { env } from "./rabbat/functions/env.ts";
import { edgeAuthenticate, resolveIdentity } from "./rabbat/functions/server.ts";

export default defineConfig({
  // Identified by RABBAT_TOKEN in .env (auto-created on first dev). In dev the
  // framework auto-starts an embedded Postgres + the shared backend; in prod set
  // RABBAT_PG_URL (external Postgres) and a stable RABBAT_TOKEN.
  // The partition's fallback token resolver (used only if edge auth is off).
  auth: resolveIdentity,
  // Edge identity resolution: runs in the Worker (DB bindings work there) and the
  // result is forwarded to the partition — so the reactive connection is
  // authenticated without the DO having to call the DB (a self-call it can't make).
  authenticate: edgeAuthenticate,
  // Enable the privileged `@rabbat/db` admin endpoint that `serverDb()` (Better
  // Auth's adapter + UploadThing auth) reaches through the partition DO binding.
  // The same key gates it on both sides (env.SERVICE_KEY, dev-defaulted).
  serviceKey: env.SERVICE_KEY,
  dbAdmin: true,
  meta: {
    title: "en — chat in orbit",
    description: "Real-time chat on a from-scratch reactive database.",
    // Canonical origin: makes the relative og:image absolute even behind a proxy
    // where the request host isn't the public one (dev: localhost; prod: APP_ORIGIN).
    baseUrl: env.APP_ORIGIN,
    openGraph: { siteName: "en", image: "/og.png" },
  },
});
