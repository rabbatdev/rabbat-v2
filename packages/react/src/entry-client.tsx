// Browser bootstrap: take the client page manifest (from `virtual:rabbat/manifest`)
// and mount the app — hydrating the SSR'd page if the server embedded a payload,
// or rendering fresh on the client otherwise. Client navigation is then driven by
// the router runtime (`RabbatRouter`), with each page's loaders + preloads run as
// it arrives.

import type { RouterManifest } from "@rabbat/router"
import type { ValueCacheOptions } from "@rabbat/client"
import { mountRabbatApp } from "./entry.js"
import { toRouterManifest, type ClientManifest } from "./manifest.js"

export type { ClientManifest, PageManifestClientEntry } from "./manifest.js"

export interface BootOptions {
  /** Persist query results to IndexedDB (stale-while-revalidate) so navigations
   *  hydrate from the disk cache instead of flashing skeletons, then go live.
   *  Forwarded to the auto-created `FunctionsClient` (which `<RabbatProvider>`
   *  creates in the root layout). `true` enables defaults; pass options to tune
   *  the LRU cap / namespace. Defaults to on. */
  persist?: boolean | ValueCacheOptions
  /** DOM id to mount into (default "root"). */
  rootId?: string
}

/**
 * Bootstrap the app from the client manifest. Accepts either the original
 * framework's `{ pages }` client manifest (adapted to rabbat-v2's router
 * manifest) or a rabbat-v2 {@link RouterManifest} directly.
 */
export async function boot(
  manifest: ClientManifest | RouterManifest,
  options: BootOptions = {},
): Promise<void> {
  const routerManifest: RouterManifest =
    "pages" in manifest ? toRouterManifest(manifest) : manifest
  // `persist` is honoured by the auto-created client in <RabbatProvider>; the
  // provider persists by default, matching the original framework's boot.
  void options.persist
  mountRabbatApp({ manifest: routerManifest, rootId: options.rootId })
}
