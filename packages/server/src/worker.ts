/// <reference lib="dom" />
import type { Modules } from "./runtime.js"

export interface WorkerConfig {
  /** DO namespace binding name (default "RABBAT_PARTITION"). */
  readonly partitionBinding?: string
  /**
   * Map a request to a partition id. Default: a single "main" partition. Shard
   * by returning different ids (e.g. per channel) to scale horizontally across
   * many Durable Objects.
   */
  readonly partitionFor?: (req: { name?: string; args?: Record<string, unknown> }) => string
  /** Modules, only used to expose names for diagnostics. */
  readonly modules?: Modules
}

interface WorkerEnv {
  [key: string]: unknown
}

const enc = new TextEncoder()

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

  const stubFor = (env: WorkerEnv, id: string): DurableObjectStub => {
    const ns = env[partitionBinding] as DurableObjectNamespace
    return ns.get(ns.idFromName(id))
  }

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url)

      // Live sync: forward the WebSocket upgrade straight to the partition DO.
      if (request.headers.get("Upgrade") === "websocket") {
        return stubFor(env, partitionFor({})).fetch(request)
      }

      if (url.pathname === "/api/query" && request.method === "POST") {
        return handleQuery(request, env, stubFor, partitionFor)
      }

      if (url.pathname === "/api/mutate" && request.method === "POST") {
        const body = await request.text()
        const parsed = JSON.parse(body) as { name?: string; args?: Record<string, unknown> }
        return stubFor(env, partitionFor(parsed)).fetch(
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
  partitionFor: (req: { name?: string; args?: Record<string, unknown> }) => string,
): Promise<Response> {
  const body = await request.text()
  const parsed = JSON.parse(body) as { name?: string; args?: Record<string, unknown>; token?: string | null }
  const cache = (caches as unknown as { default: Cache }).default
  // Namespace the cache key by identity so private results are not shared.
  const cacheKey = new Request(`https://rabbat.cache/q/${await hash(body + "|" + (parsed.token ?? ""))}`)
  const cached = await cache.match(cacheKey)

  const headers = new Headers({ "Content-Type": "application/json" })
  if (cached) {
    const w = cached.headers.get("Rabbat-Watermark")
    if (w) headers.set("If-Rabbat-Watermark", w)
  }

  const stub = stubFor(env, partitionFor(parsed))
  const res = await stub.fetch(new Request("https://do/query", { method: "POST", body, headers }))

  if (res.status === 304 && cached) {
    // Unchanged since the cached snapshot — serve the cached body, DO touched no R2.
    return new Response(cached.body, {
      headers: { "Content-Type": "application/json", "Rabbat-Watermark": res.headers.get("Rabbat-Watermark") ?? "" },
    })
  }

  // Fresh result: cache it (keyed by args+identity, validated by watermark).
  const text = await res.text()
  const toCache = new Response(text, {
    headers: {
      "Content-Type": "application/json",
      "Rabbat-Watermark": res.headers.get("Rabbat-Watermark") ?? "",
      "Cache-Control": "private, max-age=31536000",
    },
  })
  await cache.put(cacheKey, toCache.clone())
  return new Response(text, {
    headers: { "Content-Type": "application/json", "Rabbat-Watermark": res.headers.get("Rabbat-Watermark") ?? "" },
  })
}
