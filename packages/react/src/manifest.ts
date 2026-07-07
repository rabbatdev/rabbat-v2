import type {
  LayoutManifestEntry,
  RouteConfig,
  RouteManifestEntry,
  RouterManifest,
} from "@rabbat/router"

/**
 * A client-safe page-table entry, as produced by `virtual:rabbat/manifest`.
 * Mirrors the original framework's manifest shape so an app can declare
 * `virtual:rabbat/manifest` against it and pass `manifest` straight to `boot`.
 */
export interface PageManifestClientEntry {
  /** URL pattern, e.g. "/" or "/o/:orbitId". */
  pattern: string
  /** The page module: `{ default: Component, ssr?, meta? }`. */
  load: () => Promise<Record<string, unknown>>
  /** The page's companion `route.ts` (`{ Route }`), if any — the router reads
   *  `Route.ssr` / a static `Route.meta` from it. Optional/nullable so a
   *  hand-written declaration that omits it still satisfies the type. */
  loadRoute?: (() => Promise<Record<string, unknown>>) | null
  /** The page's layout modules, outermost (root) first. */
  layouts: Array<() => Promise<Record<string, unknown>>>
}

/** The client manifest shape `virtual:rabbat/manifest` exports. */
export interface ClientManifest {
  pages: PageManifestClientEntry[]
}

/**
 * Adapt the original framework's `{ pages }` client manifest into rabbat-v2's
 * {@link RouterManifest} (`{ routes, layouts }`), so `boot` can mount it through
 * the existing `mountRabbatApp` / `RabbatRouter` runtime. Layout load-fns are
 * de-duplicated by identity so a layout shared across pages keeps one stable id
 * (and therefore stays mounted across navigations within its subtree).
 */
export function toRouterManifest(manifest: ClientManifest): RouterManifest {
  const layoutIndex = new Map<() => Promise<Record<string, unknown>>, string>()
  const layouts: LayoutManifestEntry[] = []

  const idFor = (load: () => Promise<Record<string, unknown>>): string => {
    let id = layoutIndex.get(load)
    if (id === undefined) {
      id = `layout:${layouts.length}`
      layoutIndex.set(load, id)
      layouts.push({ id, load: load as () => Promise<{ default: unknown }> })
    }
    return id
  }

  const routes: RouteManifestEntry[] = manifest.pages.map((page) => ({
    pattern: page.pattern,
    ssr: true,
    load: page.load as () => Promise<{ default: unknown }>,
    ...(page.loadRoute
      ? {
          loadRoute: async () => {
            const mod = await page.loadRoute!()
            // The original convention exports `Route` (uppercase); rabbat-v2's
            // router reads `{ route }`. Accept either so both shapes work.
            const route = (mod.Route ?? mod.route ?? {}) as RouteConfig<string, unknown, Record<string, unknown>>
            return { route }
          },
        }
      : {}),
    layouts: (page.layouts ?? []).map(idFor),
  }))

  return { routes, layouts }
}
