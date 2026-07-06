/// <reference lib="dom" />
import type { Identity } from "@rabbat/functions"
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
   * Optionally resolve a verified identity at the edge (e.g. verify a JWT) so
   * `partitionFor` can shard on it. Runs on the Worker for every routed request.
   */
  readonly authenticate?: (request: Request) => Identity | null | Promise<Identity | null>
  /** Max request/cache body size in bytes (default 1 MiB). */
  readonly maxBodyBytes?: number
  /** How long a cached query body may be served on a 304 revalidation (default 1h). */
  readonly cacheTtlSeconds?: number
  /** Modules, only used to expose names for diagnostics. */
  readonly modules?: Modules
}

interface WorkerEnv {
  [key: string]: unknown
}

const enc = new TextEncoder()
const DEFAULT_MAX_BODY = 1 << 20

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

  const stubFor = (env: WorkerEnv, id: string): DurableObjectStub => {
    const ns = env[partitionBinding] as DurableObjectNamespace
    return ns.get(ns.idFromName(id))
  }

  const identityOf = (request: Request): Promise<Identity | null> =>
    config.authenticate ? Promise.resolve(config.authenticate(request)).catch(() => null) : Promise.resolve(null)

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url)
      const partitionHint = url.searchParams.get("partition")

      // Live sync: the partition is chosen per-connection from the (verified)
      // identity and/or the client's `?partition=` hint — NOT ignored as before,
      // which pinned every socket to one DO and broke sharding.
      if (request.headers.get("Upgrade") === "websocket") {
        const identity = await identityOf(request)
        const id = partitionFor({ identity, partition: partitionHint })
        return stubFor(env, id).fetch(request)
      }

      if (url.pathname === "/api/query" && request.method === "POST") {
        return handleQuery(request, env, stubFor, partitionFor, identityOf, maxBody, cacheTtl)
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
        const identity = await identityOf(request)
        const id = partitionFor({ name: parsed.name, args: parsed.args, identity, partition: partitionHint })
        return stubFor(env, id).fetch(
          new Request("https://do/mutate", { method: "POST", body, headers: request.headers }),
        )
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
  identityOf: (request: Request) => Promise<Identity | null>,
  maxBody: number,
  cacheTtl: number,
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
  const identity = await identityOf(request)
  const id = partitionFor({ name: parsed.name, args: parsed.args, identity, partition: partitionHint })

  const cache = (caches as unknown as { default: Cache }).default
  // Namespace the cache key by partition + identity/token so private results are
  // never shared across partitions or identities.
  const cacheKey = new Request(`https://rabbat.cache/q/${await hash(id + "|" + body + "|" + (parsed.token ?? ""))}`)
  const cached = await cache.match(cacheKey)

  const headers = new Headers({ "Content-Type": "application/json" })
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
        "Cache-Control": `private, max-age=${cacheTtl}`,
      },
    })
    await cache.put(cacheKey, toCache.clone())
  }
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Rabbat-Watermark": watermark },
  })
}
