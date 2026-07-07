// Integration glue between the Better Auth + UploadThing libraries and Rabbat.
//
// This builds the singletons shared by the api routes (`api/auth`,
// `api/uploadthing`) and `rabbat.config.ts` (identity). The point of the
// refactor: NO bespoke database client and NO HTTP round-trips —
//   • Better Auth runs against the framework's `serverDb()` (lazy, env-config'd)
//   • sessions resolve in-process via `auth.api.getSession` (cookie OR bearer)
// The auth + upload HTTP surfaces are mounted as ordinary Rabbat api routes.
// (Route-aware OG meta now lives in each page's `meta` export — e.g.
// pages/invite/[code].server.ts — not here.)

import { serverDb } from "rabbat/functions";
import type { Identity } from "rabbat/functions";
import { createRouteHandler } from "uploadthing/server";

import { createAuth } from "./auth.ts";
import { env } from "./env.ts";
import { makeUploadRouter } from "./uploadthing.ts";

if (env.PROD && !env.GOOGLE_ENABLED) {
  console.warn("[en] GOOGLE_CLIENT_ID/SECRET not set — Google sign-in disabled.");
}

// ── Better Auth (backed by Rabbat via the framework's lazy server client) ────
// All config comes pre-derived from `env` (see functions/env.ts).
export const auth = createAuth(serverDb(), {
  baseURL: env.AUTH_BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.TRUSTED_ORIGINS,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  devEmailAuth: env.DEV_EMAIL_AUTH,
  resendApiKey: env.RESEND_API_KEY,
  emailFrom: env.EMAIL_FROM,
  devLogOtp: !env.PROD,
});

/** Resolve a Better Auth session in-process (no HTTP round-trip). Reads the
 *  cookie OR `Authorization: Bearer` from the forwarded headers (bearer plugin). */
export async function sessionIdentity(headers: Headers): Promise<Identity | null> {
  const session = await auth.api.getSession({ headers });
  const user = session?.user;
  if (!user) return null;
  return { subject: user.id, name: user.name || user.email || user.id };
}

// ── UploadThing (avatars, covers, orbit icons, message media) ───────────────
const uploadRouter = makeUploadRouter(async (req) => {
  const id = await sessionIdentity(req.headers);
  return id?.subject ?? null;
});
export const uploadHandler = env.UPLOADTHING_TOKEN
  ? createRouteHandler({ router: uploadRouter, config: { token: env.UPLOADTHING_TOKEN, isDev: !env.PROD } })
  : null;
if (!env.UPLOADTHING_TOKEN) console.warn("[en] UPLOADTHING_TOKEN not set — image uploads are disabled.");

/** Identity for the `/functions` WebSocket (rabbat.config.ts `auth`): a bearer
 *  token (dev/e2e) or the session cookie carried on the same-origin upgrade. */
export function resolveIdentity(
  token: string | null,
  req?: { headers?: { cookie?: string | string[] } },
): Promise<Identity | null> {
  const headers = new Headers();
  const cookie = req?.headers?.cookie;
  if (token) headers.set("authorization", `Bearer ${token}`);
  else if (typeof cookie === "string") headers.set("cookie", cookie);
  else return Promise.resolve(null);
  return sessionIdentity(headers);
}
