// rabbat/functions → @rabbat/functions, plus `serverDb()` (the original's
// server-side ad-hoc DB client), mapped onto @rabbat/db.
//
// In rabbat-v2 the database lives behind a partition Durable Object. Server-side
// code reaches it either through the in-edge DO binding (preferred: no network
// hop, works inside workerd) or, as a fallback, the HTTP admin endpoint.
//
// Because a Worker only receives its bindings per-request via `env`, call
// `configureServerDb({ namespace, serviceKey })` from a request context (an api
// route handler, or the worker) BEFORE the auth adapter runs. `serverDb()` then
// resolves that binding lazily on each call. Without a configured binding it
// falls back to the HTTP transport (RABBAT_ADMIN_URL / APP_ORIGIN + /_rabbat/db).

export * from "@rabbat/functions"

import type { DataModel } from "@rabbat/schema"
import {
  bindingTransport,
  createRabbatDb,
  httpTransport,
  type DbRequest,
  type DbTransport,
  type DurableNamespaceLike,
  type RabbatDb,
} from "@rabbat/db"

export interface ServerDbOptions {
  /** Admin endpoint URL (HTTP fallback). Default: RABBAT_ADMIN_URL, else APP_ORIGIN/_rabbat/db. */
  url?: string
  /** Service key. Default: the configured binding's key, else RABBAT_SERVICE_KEY. */
  serviceKey?: string
  /** Partition to target (default "main"). */
  partition?: string
  /** Inject fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch
}

/** The per-request DO binding + service key the worker publishes for serverDb. */
export interface ServerDbBinding {
  namespace: DurableNamespaceLike
  serviceKey: string
  partition?: string
}

let boundEnv: ServerDbBinding | null = null

/**
 * Publish the partition DO binding (and service key) serverDb should use. Call
 * this from a request context — the api route handler or the worker — before the
 * auth adapter reads/writes. In-edge binding calls avoid the workerd loopback
 * limitation that breaks a Worker fetching its own origin.
 */
export function configureServerDb(binding: ServerDbBinding): void {
  boundEnv = binding
}

function envUrl(): string {
  const env = typeof process !== "undefined" ? process.env : {}
  if (env.RABBAT_ADMIN_URL) return env.RABBAT_ADMIN_URL
  const origin = (env.APP_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "")
  return `${origin}/_rabbat/db`
}

/**
 * A server-side database client usable outside a function context (e.g. an auth
 * adapter). Reads/writes go through the partition (durable, engine-validated,
 * reactive). Server-only — never ship the key. Prefer a configured DO binding
 * (configureServerDb); falls back to HTTP.
 */
export function serverDb<DM extends DataModel = DataModel>(opts: ServerDbOptions = {}): RabbatDb<DM> {
  const env = typeof process !== "undefined" ? process.env : {}
  // Resolve the transport lazily on every call so a per-request binding
  // published after this client was created is still picked up.
  const transport: DbTransport = {
    call(req: DbRequest) {
      if (boundEnv) {
        return bindingTransport({
          namespace: boundEnv.namespace,
          serviceKey: opts.serviceKey ?? boundEnv.serviceKey,
          partition: opts.partition ?? boundEnv.partition,
        }).call(req)
      }
      return httpTransport({
        url: opts.url ?? envUrl(),
        serviceKey: opts.serviceKey ?? env.RABBAT_SERVICE_KEY ?? "",
        partition: opts.partition,
        fetch: opts.fetch,
      }).call(req)
    },
  }
  return createRabbatDb<DM>(transport)
}
