import { type RouterHistory } from "./history.js"
import { compileRoutes, type CompiledRoute, matchRoute } from "./matcher.js"
import { parseSearch } from "./params.js"
import type {
  LayoutConfig,
  LoaderContext,
  Match,
  MetaDescriptor,
  NavigateOptions,
  RouteConfig,
  RouterManifest,
  RouterState,
} from "./types.js"

/** Built per navigation by the adapter; `collectPreloads` returns what loaders preloaded. */
export type LoaderContextFactory = () => {
  context: LoaderContext
  collectPreloads: () => Record<string, unknown>
}

export interface CreateRouterOptions {
  readonly manifest: RouterManifest
  readonly history: RouterHistory
  readonly makeContext: LoaderContextFactory
  /** Seed for SSR hydration: the first match + loader data, so loaders don't re-run. */
  readonly initial?: { state: RouterState }
}

export interface Router {
  subscribe(cb: () => void): () => void
  getSnapshot(): RouterState
  navigate(href: string, opts?: NavigateOptions): Promise<void>
  /** Warm the modules + loaders for a route (hover/intent prefetch). */
  prefetch(href: string): Promise<void>
  /** Re-run the current route's loaders. */
  refresh(): Promise<void>
}

const EMPTY_META: MetaDescriptor = {}

export function createRouter(opts: CreateRouterOptions): Router {
  const routes = compileRoutes(opts.manifest)
  const layoutsById = new Map(opts.manifest.layouts.map((l) => [l.id, l]))
  const listeners = new Set<() => void>()
  let navToken = 0

  let state: RouterState = opts.initial?.state ?? {
    href: "/",
    pathname: "/",
    searchString: "",
    match: null,
    loaderData: {},
    meta: EMPTY_META,
    status: "idle",
    error: null,
  }

  const emit = () => {
    for (const cb of listeners) cb()
  }
  const set = (next: RouterState) => {
    state = next
    emit()
  }

  const resolve = async (
    href: string,
    routesList: ReadonlyArray<CompiledRoute>,
  ): Promise<RouterState> => {
    const url = new URL(href, "http://x")
    const match = matchRoute(routesList, url.pathname)
    if (!match) {
      return { href, pathname: url.pathname, searchString: url.search, match: null, loaderData: {}, meta: EMPTY_META, status: "idle", error: null }
    }

    // Load the config + component modules for the route and its layout chain.
    const layoutEntries = match.route.layouts.map((id) => layoutsById.get(id)).filter((l) => l !== undefined)
    const [routeMod] = await Promise.all([
      match.route.loadRoute?.(),
      match.route.load(),
      ...layoutEntries.flatMap((l) => [l.load(), l.loadRoute?.()]),
    ])
    const routeConfig = routeMod?.route as RouteConfig<string, unknown, Record<string, unknown>> | undefined

    const controller = new AbortController()
    const { context } = opts.makeContext()
    const search = parseSearch(routeConfig?.search ?? {}, url.search)

    const loaderData: Record<string, unknown> = {}
    const metas: MetaDescriptor[] = []

    // Layout loaders run outermost-first, then the route loader.
    for (const layout of layoutEntries) {
      const cfg = (await layout.loadRoute?.())?.layout as LayoutConfig<unknown> | undefined
      if (cfg?.loader) {
        const data = await cfg.loader({ context, signal: controller.signal })
        loaderData[layout.id] = data
        if (cfg.meta) metas.push(cfg.meta({ data }))
      }
    }
    let routeData: unknown = undefined
    if (routeConfig?.loader) {
      routeData = await routeConfig.loader({ params: match.params, search, context, signal: controller.signal })
      loaderData["route"] = routeData
    }
    if (routeConfig?.meta) metas.push(routeConfig.meta({ data: routeData, params: match.params, search }))

    return {
      href,
      pathname: url.pathname,
      searchString: url.search,
      match,
      loaderData,
      meta: mergeMeta(metas),
      status: "idle",
      error: null,
    }
  }

  const navigate = async (href: string, navOpts: NavigateOptions = {}): Promise<void> => {
    const token = ++navToken
    set({ ...state, status: "loading" })
    try {
      const next = await resolve(href, routes)
      if (token !== navToken) return // a newer navigation superseded this one
      const cur = opts.history.location()
      if (`${cur.pathname}${cur.search}` !== href) {
        if (navOpts.replace) opts.history.replace(href)
        else opts.history.push(href)
      }
      set(next)
    } catch (error) {
      if (token === navToken) set({ ...state, status: "idle", error })
    }
  }

  // Track external navigation (back/forward).
  opts.history.listen(() => {
    const loc = opts.history.location()
    void navigate(`${loc.pathname}${loc.search}`, { replace: true })
  })

  return {
    subscribe: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    getSnapshot: () => state,
    navigate,
    prefetch: async (href) => {
      await resolve(href, routes).catch(() => undefined)
    },
    refresh: async () => {
      const next = await resolve(state.href, routes)
      set(next)
    },
  }
}

function mergeMeta(metas: ReadonlyArray<MetaDescriptor>): MetaDescriptor {
  let title: string | undefined
  const tags: NonNullable<MetaDescriptor["tags"]>[number][] = []
  for (const m of metas) {
    if (m.title !== undefined) title = m.title
    if (m.tags) tags.push(...m.tags)
  }
  return { title, tags }
}
