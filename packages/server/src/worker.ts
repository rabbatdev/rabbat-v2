/// <reference lib="dom" />
import type { ServerRouteDef } from "@rabbat/router"
import type { Identity } from "@rabbat/functions"
import { createApiApp } from "./api.js"
import type { Modules } from "./runtime.js"

/** What the router knows about a request when choosing a partition. */
export interface RouteInfo {
  readonly name?: string
  readonly args?: Record<string, unknown>
  /** The verified identity, when `authenticate` is configured. */
  readonly identity?: Identity | null
  /** The `?partition=` hint from the client (WebSocket + HTTP). */
  readonly partition?: string | null
}

export interface WorkerConfig {
  /** DO namespace binding name (default "RABBAT_PARTITION"). */
  readonly partitionBinding?: string
  /**
   * Map a request to a partition id. Default: a single "main" partition. Shard
   * by returning different ids to scale horizontally across many Durable Objects.
   *
   * SECURITY: when sharding per tenant, derive the id from `info.identity`
   * (verified — requires `authenticate`), NOT from `info.args`, which is
   * unauthenticated client input. Routing on client args lets a caller target
   * another tenant's partition.
   */
  readonly partitionFor?: (info: RouteInfo) => string
  /**
   * Resolve a verified identity at the edge (e.g. verify a session/JWT). Runs on
   * the Worker for every routed request — where DB bindings work — and the result
   * is forwarded to the partition via a trusted internal header, so the DO never
   * re-authenticates. `partitionFor` can also shard on it. `env` carries the
   * Worker bindings (e.g. the partition DO namespace) for DB-backed session lookup.
   */
  readonly authenticate?: (request: Request, env: WorkerEnv) => Identity | null | Promise<Identity | null>
  /** Max request/cache body size in bytes (default 1 MiB). */
  readonly maxBodyBytes?: number
  /** How long a cached query body may be served on a 304 revalidation (default 1h). */
  readonly cacheTtlSeconds?: number
  /**
   * Expose the privileged `@rabbat/db` admin endpoint over HTTP at
   * `POST /_rabbat/db` (forwarded to the partition's service-key-gated `/db`).
   * Off by default. Only enable for server-to-server use behind TLS; the
   * partition still enforces the service key, so a leaked route alone grants
   * nothing. Prefer the in-Worker `bindingTransport` and leave this off.
   *
   * NOTE: admin routing uses only the client-supplied `?partition=` hint (there
   * is no request identity to shard on), so a sharded backend's `partitionFor`
   * is called with just `{ partition }`. The service key is a full-partition
   * master credential — a holder can target any partition.
   */
  readonly dbAdmin?: boolean
  /** `defineServerRoute` definitions, mounted on Hono after the built-in routes. */
  readonly apiRoutes?: ReadonlyArray<ServerRouteDef>
  /**
   * Resolve a token into an identity for API-route contexts. Mirror the
   * partition's `auth` so an API route and a function see the same identity.
   */
  readonly auth?: (token: string | null) => Identity | null | Promise<Identity | null>
  /** Modules, only used to expose names for diagnostics. */
  readonly modules?: Modules
}

interface WorkerEnv {
  [key: string]: unknown
}

const enc = new TextEncoder()
const DEFAULT_MAX_BODY = 1 << 20

/**
 * The trusted internal header carrying the edge-resolved identity from the Worker
 * to its partition DO. The Worker is the only thing that can reach the DO, so the
 * DO trusts this — but the Worker MUST strip any client-supplied value first
 * (a client could otherwise inject an identity).
 */
export const INTERNAL_IDENTITY_HEADER = "X-Rabbat-Identity"

/**
 * Stamp the edge-resolved identity. When edge auth is in play (`edgeAuth`), the
 * header is ALWAYS set — to the identity JSON, or literal `null` for an
 * anonymous connection — so the partition trusts it and skips its own auth. Any
 * client-supplied value is stripped first. When edge auth is off, the header is
 * removed and the partition falls back to its `auth` (token) resolver.
 */
function setInternalIdentity(headers: Headers, identity: Identity | null, edgeAuth: boolean): void {
  headers.delete(INTERNAL_IDENTITY_HEADER) // never trust a client-provided value
  if (edgeAuth) headers.set(INTERNAL_IDENTITY_HEADER, JSON.stringify(identity))
}

/** Clone a request, replacing the trusted identity header with the resolved one. */
function withInternalIdentity(request: Request, identity: Identity | null, edgeAuth: boolean): Request {
  const headers = new Headers(request.headers)
  setInternalIdentity(headers, identity, edgeAuth)
  return new Request(request, { headers })
}

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s))
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * The routing / SSR / cache Worker. It forwards WebSocket upgrades and HTTP
 * function calls to the owning partition Durable Object, and fronts one-shot
 * queries with a conditional cache: it revalidates against the DO with the
 * cached commit watermark, and on `304 Not Modified` serves the cached body
 * without the DO reading R2 — cutting reads and egress for hot, unchanged queries.
 */
export function defineWorker(config: WorkerConfig = {}): ExportedHandler<WorkerEnv> {
  const partitionBinding = config.partitionBinding ?? "RABBAT_PARTITION"
  const partitionFor = config.partitionFor ?? (() => "main")
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY
  const cacheTtl = config.cacheTtlSeconds ?? 3600
  // When edge auth is configured, the Worker resolves identity and forwards it;
  // the partition trusts that and skips its own token resolver.
  const edgeAuth = Boolean(config.authenticate)

  const stubFor = (env: WorkerEnv, id: string): DurableObjectStub => {
    const ns = env[partitionBinding] as DurableObjectNamespace
    return ns.get(ns.idFromName(id))
  }

  const identityOf = (request: Request, env: WorkerEnv): Promise<Identity | null> =>
    config.authenticate
      ? Promise.resolve(config.authenticate(request, env)).catch(() => null)
      : Promise.resolve(null)

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url)
      const partitionHint = url.searchParams.get("partition")

      // Live sync: the partition is chosen per-connection from the (verified)
      // identity and/or the client's `?partition=` hint — NOT ignored as before,
      // which pinned every socket to one DO and broke sharding. The identity is
      // resolved HERE at the edge (where DB bindings work) and forwarded to the
      // partition via a trusted internal header, so the DO never has to
      // re-authenticate (a self-call it can't make).
      if (request.headers.get("Upgrade") === "websocket") {
        const identity = await identityOf(request, env)
        const id = partitionFor({ identity, partition: partitionHint })
        return stubFor(env, id).fetch(withInternalIdentity(request, identity, edgeAuth))
      }

      if (url.pathname === "/api/query" && request.method === "POST") {
        return handleQuery(request, env, stubFor, partitionFor, identityOf, maxBody, cacheTtl, edgeAuth)
      }

      if (url.pathname === "/api/mutate" && request.method === "POST") {
        const body = await request.text()
        if (body.length > maxBody) return new Response("payload too large", { status: 413 })
        let parsed: { name?: string; args?: Record<string, unknown> }
        try {
          parsed = JSON.parse(body)
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } })
        }
        const identity = await identityOf(request, env)
        const id = partitionFor({ name: parsed.name, args: parsed.args, identity, partition: partitionHint })
        return stubFor(env, id).fetch(
          withInternalIdentity(new Request("https://do/mutate", { method: "POST", body, headers: request.headers }), identity, edgeAuth),
        )
      }

      // Privileged admin DB endpoint (opt-in), forwarded to the owning partition
      // which enforces the service key. The key travels in the header unchanged.
      if (config.dbAdmin && url.pathname === "/_rabbat/db" && request.method === "POST") {
        const body = await request.text()
        if (body.length > maxBody) return new Response("payload too large", { status: 413 })
        const id = partitionFor({ partition: partitionHint })
        return stubFor(env, id).fetch(
          new Request("https://do/db", { method: "POST", body, headers: request.headers }),
        )
      }

      // User-defined edge API routes (`defineServerRoute`), mounted on Hono.
      // Their `ctx.run*` proxy to the owning partition's `/call` endpoint, which
      // validates args + resolves identity exactly like a function call.
      if (config.apiRoutes && config.apiRoutes.length > 0) {
        const app = createApiApp(config.apiRoutes, {
          auth: config.auth ?? (() => null),
          env: env as Record<string, unknown>,
          call: async (kind, name, args, token) => {
            const res = await stubFor(env, partitionFor({ name, args, partition: partitionHint })).fetch(
              new Request("https://do/call", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind, name, args, token }),
              }),
            )
            if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "call failed")
            return ((await res.json()) as { value: unknown }).value
          },
        })
        const res = await app.fetch(request)
        if (res.status !== 404) return res
      }

      return new Response("rabbat: not found", { status: 404 })
    },
  }
}

async function handleQuery(
  request: Request,
  env: WorkerEnv,
  stubFor: (env: WorkerEnv, id: string) => DurableObjectStub,
  partitionFor: (info: RouteInfo) => string,
  identityOf: (request: Request, env: WorkerEnv) => Promise<Identity | null>,
  maxBody: number,
  cacheTtl: number,
  edgeAuth: boolean,
): Promise<Response> {
  const body = await request.text()
  if (body.length > maxBody) return new Response("payload too large", { status: 413 })
  let parsed: { name?: string; args?: Record<string, unknown>; token?: string | null }
  try {
    parsed = JSON.parse(body)
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  const partitionHint = new URL(request.url).searchParams.get("partition")
  const identity = await identityOf(request, env)
  const id = partitionFor({ name: parsed.name, args: parsed.args, identity, partition: partitionHint })

  const cache = (caches as unknown as { default: Cache }).default
  // Namespace the cache key by partition + identity so private results are never
  // shared across partitions or identities.
  const cacheKey = new Request(
    `https://rabbat.cache/q/${await hash(id + "|" + body + "|" + (identity ? JSON.stringify(identity) : parsed.token ?? ""))}`,
  )
  const cached = await cache.match(cacheKey)

  const headers = new Headers({ "Content-Type": "application/json" })
  setInternalIdentity(headers, identity, edgeAuth)
  if (cached) {
    const w = cached.headers.get("Rabbat-Watermark")
    if (w) headers.set("If-Rabbat-Watermark", w)
  }

  const stub = stubFor(env, id)
  const res = await stub.fetch(new Request("https://do/query", { method: "POST", body, headers }))

  if (res.status === 304 && cached) {
    // Unchanged since the cached snapshot — serve the cached body, DO touched no R2.
    return new Response(cached.body, {
      headers: { "Content-Type": "application/json", "Rabbat-Watermark": res.headers.get("Rabbat-Watermark") ?? "" },
    })
  }

  const text = await res.text()
  // Only cache successful, watermarked responses (never a 4xx/5xx error body).
  const watermark = res.headers.get("Rabbat-Watermark") ?? ""
  if (res.ok && watermark) {
    const toCache = new Response(text, {
      headers: {
        "Content-Type": "application/json",
        "Rabbat-Watermark": watermark,
        // NOTE: must NOT be `private` — Cloudflare's shared Cache API refuses to
        // store `Cache-Control: private` responses, which would silently disable
        // this whole conditional-cache path. Privacy is enforced by the cache KEY
        // (hashed over partition id + args + token), not by this header.
        "Cache-Control": `max-age=${cacheTtl}`,
      },
    })
    await cache.put(cacheKey, toCache.clone())
  }
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Rabbat-Watermark": watermark },
  })
}
