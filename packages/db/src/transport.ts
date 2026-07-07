import { type DbRequest, type DbResponse, SERVICE_KEY_HEADER } from "@rabbat/protocol"

/**
 * How a `RabbatDb` reaches a partition's `/db` endpoint. A transport performs
 * one request and returns the `value` of a successful {@link DbResponse}, or
 * throws on an error response / transport failure.
 */
export interface DbTransport {
  call(req: DbRequest): Promise<unknown>
}

/** A Durable Object stub (structural — avoids a hard dep on workers-types). */
export interface DurableStubLike {
  fetch(input: Request): Promise<Response>
}
/** A Durable Object namespace binding (structural). */
export interface DurableNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DurableStubLike
}

async function unwrap(res: Response): Promise<unknown> {
  let body: DbResponse
  try {
    body = (await res.json()) as DbResponse
  } catch {
    throw new RabbatDbError(`rabbat/db: bad response (${res.status})`, res.status)
  }
  if (!body || body.ok !== true) {
    throw new RabbatDbError(
      (body && "error" in body && body.error) || `rabbat/db: request failed (${res.status})`,
      res.status,
    )
  }
  return body.value
}

export class RabbatDbError extends Error {
  override readonly name = "RabbatDbError"
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface BindingTransportOptions {
  /** The `RABBAT_PARTITION` Durable Object namespace binding. */
  readonly namespace: DurableNamespaceLike
  /** Must equal the partition's configured `serviceKey`. */
  readonly serviceKey: string
  /** Which partition to target (default `"main"`). Match your `partitionFor`. */
  readonly partition?: string
}

/**
 * Talk to the partition directly through its Durable Object binding — the most
 * secure transport: the request never leaves the Cloudflare edge, so the service
 * key is never sent over the public internet. Use this from a trusted Worker
 * (e.g. an auth adapter) that has the `RABBAT_PARTITION` binding.
 */
export function bindingTransport(options: BindingTransportOptions): DbTransport {
  const partition = options.partition ?? "main"
  return {
    async call(req) {
      const ns = options.namespace
      const stub = ns.get(ns.idFromName(partition))
      const res = await stub.fetch(
        new Request("https://rabbat.internal/db", {
          method: "POST",
          headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: options.serviceKey },
          body: JSON.stringify(req),
        }),
      )
      return unwrap(res)
    },
  }
}

export interface HttpTransportOptions {
  /**
   * The admin endpoint URL (an admin Worker route that forwards to `/db`).
   * Prefer {@link bindingTransport} when running inside a Worker; use HTTP only
   * for out-of-edge services, and always over TLS.
   */
  readonly url: string
  /** Must equal the partition's configured `serviceKey`. */
  readonly serviceKey: string
  /** Optional partition hint, forwarded as `?partition=` for a sharded backend. */
  readonly partition?: string
  /** Inject a `fetch` (e.g. for Node < 18 or tests). Defaults to global fetch. */
  readonly fetch?: typeof fetch
}

/**
 * Talk to the partition over HTTPS via an admin route (see `defineWorker`'s
 * `dbAdmin`). For server-to-server use only — the service key authenticates the
 * caller, so it must never ship to a browser.
 */
export function httpTransport(options: HttpTransportOptions): DbTransport {
  const doFetch = options.fetch ?? fetch
  const base = options.partition
    ? `${options.url}${options.url.includes("?") ? "&" : "?"}partition=${encodeURIComponent(options.partition)}`
    : options.url
  return {
    async call(req) {
      const res = await doFetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SERVICE_KEY_HEADER]: options.serviceKey },
        body: JSON.stringify(req),
      })
      return unwrap(res)
    },
  }
}
