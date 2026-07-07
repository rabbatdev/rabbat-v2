import type { PathParams } from "./params.js"
import type {
  LayoutConfig,
  LayoutDef,
  RouteConfig,
  RouteDef,
  RouterRuntime,
} from "./types.js"

// The active framework runtime (React today; Vue/Svelte later). Registered by
// the adapter so `route.useParams()` etc. resolve against the right reactivity.
let runtime: RouterRuntime | null = null

export function registerRouterRuntime(r: RouterRuntime): void {
  runtime = r
}

function rt(): RouterRuntime {
  if (!runtime) throw new Error("rabbat router: no framework runtime registered (did you mount <RabbatRouter>?)")
  return runtime
}

/**
 * Define a route. The `path` lives in the config — the single source of truth for
 * params — so there's no magic `./$route` import, yet `loader`/`meta` and the
 * returned `useParams`/`useSearch`/`useLoaderData` hooks are all typed from it.
 *
 * ```ts
 * export const route = defineRoute({
 *   path: "/channels/:channelId",
 *   loader: ({ params, context }) => ({ channel: context.preload(api.channels.get, { id: params.channelId }) }),
 *   meta: ({ data }) => ({ title: data.channel.name }),
 *   ssr: false,   // client-side navigation; still SSR'd on first load
 * })
 * ```
 */
export function defineRoute<
  const Path extends string,
  Loader = undefined,
  Search extends Record<string, unknown> = Record<string, never>,
>(config: RouteConfig<Path, Loader, Search>): RouteDef<Path, Loader, Search> {
  return {
    ...config,
    __params: undefined as never,
    __loader: undefined as never,
    __search: undefined as never,
    useParams: () => rt().useParams() as PathParams<Path>,
    useSearch: () => rt().useSearch() as Search,
    useLoaderData: () => rt().useLoaderData() as Awaited<Loader>,
  }
}

/**
 * Define a layout's data/meta. The layout's *view* (the component with `<Outlet/>`)
 * is the neighboring `_layout.tsx`; this configures its loader and metadata.
 */
export function defineLayout<Loader = undefined>(config: LayoutConfig<Loader> = {}): LayoutDef<Loader> {
  return {
    ...config,
    __loader: undefined as never,
    useLoaderData: () => rt().useLoaderData() as Awaited<Loader>,
  }
}
