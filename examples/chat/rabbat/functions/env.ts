// Validated + derived environment for "en", via the framework's t3-env wrapper.
// `shared`/`server` (no `client` vars — this app is same-origin) are validated
// with the server/client safety guarantees; `derive` folds them into the computed
// values the app uses (ports, origins, flags). So there's no `process.env.X ??
// default` sprawl and no derivation logic scattered through the app — it's here.

import { defineEnv, rabbatToken, z } from "rabbat/env";

const prod = process.env.NODE_ENV === "production";

// The resolved shape of `env`. `defineEnv`'s generic return collapses to `never`
// under zod's generic-shape inference (validated + derived fields intersect),
// so annotate the export explicitly: the raw validated vars plus the derived
// keys (which override same-named raw vars with their resolved types).
export interface Env {
  NODE_ENV: string;
  PORT: number;
  APP_PORT?: number;
  RABBAT_DB_URL: string;
  RABBAT_TOKEN?: string;
  APP_ORIGIN: string;
  AUTH_BASE_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  UPLOADTHING_TOKEN?: string;
  RABBAT_SERVICE_KEY?: string;
  // Derived.
  PROD: boolean;
  DEV_EMAIL_AUTH: boolean;
  TRUSTED_ORIGINS: string[];
  GOOGLE_ENABLED: boolean;
  SERVICE_KEY: string;
}

export const env: Env = defineEnv({
  // Available on both sides.
  shared: {
    NODE_ENV: z.string().default("development"),
  },
  // Server-only — never reaches the browser bundle.
  server: {
    PORT: z.coerce.number().optional(),
    APP_PORT: z.coerce.number().optional(),

    // Rabbat backend — the framework writes RABBAT_TOKEN to .env on first `dev`.
    RABBAT_DB_URL: z.string().default("ws://127.0.0.1:3652/ws"),
    RABBAT_TOKEN: rabbatToken().optional(),

    // Better Auth — secret is required in production, defaulted in dev.
    APP_ORIGIN: z.string().url().optional(),
    AUTH_BASE_URL: z.string().url().optional(),
    BETTER_AUTH_SECRET: prod
      ? z.string().min(1, "required in production")
      : z.string().default("en-demo-better-auth-secret-change-me"),
    GOOGLE_CLIENT_ID: z.string().default(""),
    GOOGLE_CLIENT_SECRET: z.string().default(""),
    TRUSTED_ORIGINS: z.string().optional(),
    DEV_EMAIL_AUTH: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default("en <hello@en.winglee.dev>"),

    // UploadThing — unset disables uploads.
    UPLOADTHING_TOKEN: z.string().optional(),

    // Service key gating the partition's admin DB endpoint (serverDb). In
    // workerd process.env is empty, so this defaults to a dev value used
    // consistently by both the partition config and serverDb.
    RABBAT_SERVICE_KEY: z.string().optional(),
  },
  // Derived keys use env-style names; ones matching a raw var (APP_ORIGIN,
  // AUTH_BASE_URL, PORT, DEV_EMAIL_AUTH, TRUSTED_ORIGINS) OVERRIDE it with the
  // resolved value, so consumers always read the final value off `env`.
  derive: (e) => {
    const PROD = e.NODE_ENV === "production";
    // rabbat-v2 runs the app on Vite's dev server (default 5173), not the
    // original framework's 3650 host.
    const PORT = e.PORT ?? e.APP_PORT ?? 5173;
    const APP_ORIGIN = (e.APP_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");
    const AUTH_BASE_URL = (e.AUTH_BASE_URL ?? APP_ORIGIN).replace(/\/$/, "");
    return {
      PROD,
      PORT,
      APP_ORIGIN,
      AUTH_BASE_URL,
      // Email+password (the dev "sign in as test user" button): on by default in
      // dev, off in prod unless DEV_EMAIL_AUTH=1.
      DEV_EMAIL_AUTH: PROD ? e.DEV_EMAIL_AUTH === "1" : e.DEV_EMAIL_AUTH !== "0",
      // Prod: trust the configured origins. Dev: trust localhost / 127.0.0.1 /
      // LAN hosts on ANY port (Better Auth supports `*` wildcards), so it works
      // regardless of which port Vite picks (5173, 5174, …) — otherwise Better
      // Auth rejects the request with "Invalid origin".
      TRUSTED_ORIGINS: PROD
        ? (e.TRUSTED_ORIGINS ?? APP_ORIGIN).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)
        : [
            APP_ORIGIN,
            "http://localhost:*",
            "http://127.0.0.1:*",
            "http://*:*",
            "https://*:*",
          ],
      GOOGLE_ENABLED: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
      // Same value on both sides of the admin endpoint (partition + serverDb).
      SERVICE_KEY: e.RABBAT_SERVICE_KEY ?? "rabbat-dev-service-key",
    };
  },
});
