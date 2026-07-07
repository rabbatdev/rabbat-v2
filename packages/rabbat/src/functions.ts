// rabbat/functions → @rabbat/functions, plus `serverDb()` (the original's
// server-side ad-hoc DB client), mapped onto @rabbat/db.
//
// The original `serverDb()` returned a global client to the always-on database.
// In rabbat-v2 the database lives behind a partition; server-side code reaches
// it through the service-key-gated admin endpoint. `serverDb()` therefore
// returns a `@rabbat/db` client over an HTTP transport, configured from the
// environment (or explicit options). Enable it with `dbAdmin: true` + a
// `serviceKey` in `rabbat.config.ts`.

export * from "@rabbat/functions"

import type { DataModel } from "@rabbat/schema"
import { createRabbatDb, httpTransport, type RabbatDb } from "@rabbat/db"

export interface ServerDbOptions {
  /** Admin endpoint URL. Default: `RABBAT_ADMIN_URL`, else `${APP_ORIGIN}/_rabbat/db`. */
  url?: string
  /** Service key. Default: `RABBAT_SERVICE_KEY`. */
  serviceKey?: string
  /** Partition to target (default "main"). */
  partition?: string
  /** Inject fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch
}

function envUrl(): string {
  const env = typeof process !== "undefined" ? process.env : {}
  if (env.RABBAT_ADMIN_URL) return env.RABBAT_ADMIN_URL
  const origin = (env.APP_ORIGIN ?? "http://localhost:3650").replace(/\/$/, "")
  return `${origin}/_rabbat/db`
}

/**
 * A server-side database client usable outside a function context (e.g. an auth
 * adapter). Reads/writes go through the partition's admin endpoint; writes stay
 * durable, engine-validated, and reactive. Server-only — never ship the key.
 */
export function serverDb<DM extends DataModel = DataModel>(opts: ServerDbOptions = {}): RabbatDb<DM> {
  const env = typeof process !== "undefined" ? process.env : {}
  return createRabbatDb<DM>(
    httpTransport({
      url: opts.url ?? envUrl(),
      serviceKey: opts.serviceKey ?? env.RABBAT_SERVICE_KEY ?? "",
      partition: opts.partition,
      fetch: opts.fetch,
    }),
  )
}
