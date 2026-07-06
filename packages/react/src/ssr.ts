import { preloadKey, type Preload } from "@rabbat/client"
import type { ArgsOf, FunctionReference } from "@rabbat/functions"
import type { PaginationOpts } from "@rabbat/protocol"

/**
 * Run a query at the edge (against the Worker's `/api/query`, which is cached and
 * conditional) and return its preload entry. Collect these in a loader, pass the
 * map to a `FunctionsClient({ preloaded })` for the server render, and embed it
 * in the HTML — the client constructs the same `preloaded` map so `useQuery`
 * renders with data immediately and then goes live with no flash or refetch.
 */
export async function preloadQuery<Ref extends FunctionReference<"query", any, any>>(
  baseUrl: string,
  ref: Ref,
  args: Omit<ArgsOf<Ref>, "paginationOpts"> & Record<string, unknown>,
  opts?: { pagination?: PaginationOpts; token?: string | null },
): Promise<{ key: string; preload: Preload }> {
  const res = await fetch(`${baseUrl}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: ref.name, args, pagination: opts?.pagination, token: opts?.token ?? null }),
  })
  // Never seed an error body as data: a non-OK response has no valid Preload.
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`preloadQuery ${ref.name} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`)
  }
  const preload = (await res.json()) as Preload
  return { key: preloadKey(ref.name, args), preload }
}

/** Assemble preload entries into the map a `FunctionsClient` expects. */
export function buildPreloadMap(
  entries: ReadonlyArray<{ key: string; preload: Preload }>,
): Record<string, Preload> {
  const map: Record<string, Preload> = {}
  for (const e of entries) map[e.key] = e.preload
  return map
}

/** Serialize the preload map for embedding in server-rendered HTML. */
export function embedPreloads(map: Record<string, Preload>): string {
  return JSON.stringify(map).replace(/</g, "\\u003c")
}
