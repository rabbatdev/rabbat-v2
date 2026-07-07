// rabbat/config → typed project config for a rabbat-v2 app.
//
// `defineConfig` is (mostly) identity: it types the `rabbat.config.ts` default
// export that the generated Worker reads (auth / partitionFor / serviceKey /
// dbAdmin / meta …). The original framework accepted a `meta` (SiteMeta) block
// for SSR <head>; rabbat-v2 threads that through the router adapter.

import type { Identity } from "@rabbat/functions"

/** Default document metadata (Open Graph / Twitter / title) for SSR. */
export interface SiteMeta {
  title?: string
  description?: string
  /** Canonical origin, so relative og:image URLs resolve behind a proxy. */
  baseUrl?: string
  openGraph?: { siteName?: string; image?: string }
  twitter?: { card?: string; site?: string }
}

export interface RabbatConfig {
  /**
   * Resolve a connection's identity. rabbat-v2 passes the connection token
   * (query param / first-message); return the signed-in identity or null. An app
   * that authenticates from request headers (cookie/bearer) should resolve the
   * token accordingly.
   */
  auth?: (token: string | null) => Identity | null | Promise<Identity | null>
  /** Shard requests across partitions (default single "main"). */
  partitionFor?: (info: { name?: string; args?: Record<string, unknown>; identity?: Identity | null; partition?: string | null }) => string
  /**
   * Resolve a verified identity at the edge (in the Worker, where DB bindings
   * work). The result is forwarded to the partition, so the reactive connection
   * is authenticated without the DO calling the DB. `env` carries the Worker
   * bindings (e.g. the partition DO namespace).
   */
  authenticate?: (request: Request, env: Record<string, unknown>) => Identity | null | Promise<Identity | null>
  /** Service key enabling the privileged `@rabbat/db` admin endpoint. */
  serviceKey?: string
  /** Expose the admin DB endpoint over HTTP (server-to-server). */
  dbAdmin?: boolean
  /** Reject unindexed paginated/collect queries. */
  strictIndexes?: boolean
  /** Byte-based memtable flush threshold. */
  flushBytes?: number
  /** Max inbound message bytes. */
  maxMessageBytes?: number
  /** Default document metadata for SSR (per-route `meta` overrides this). */
  meta?: SiteMeta
}

/** Identity — exists to type `rabbat.config.ts`'s default export. */
export function defineConfig(config: RabbatConfig): RabbatConfig {
  return config
}
