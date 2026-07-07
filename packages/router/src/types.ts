import type { PaginationOpts } from "@rabbat/protocol"
import type { ArgsOf, FunctionReference, Identity, ReturnOf } from "@rabbat/functions"
import type { PathParams } from "./params.js"

/** Document metadata a route contributes (react-helmet-style, merged by depth). */
export interface MetaDescriptor {
  readonly title?: string
  readonly tags?: ReadonlyArray<{ name?: string; property?: string; content: string }>
}

/**
 * The context a loader runs in. `preload` runs a reactive query and registers it
 * for SSR embedding + client seeding, so the page renders with data and goes
 * live with no flash.
 */
export interface LoaderContext {
  /**
   * Run a reactive query and register it for client seeding (no-flash). For a
   * paginated query, pass the initial window in `opts.pagination`; the seed is
   * keyed by the same args the `usePaginatedQuery` hook uses.
   */
  preload<Ref extends FunctionReference<"query", any, any>>(
    ref: Ref,
    args: Omit<ArgsOf<Ref>, "paginationOpts">,
    opts?: { pagination?: PaginationOpts },
  ): Promise<ReturnOf<Ref>>
  runQuery<Ref extends FunctionReference<"query", any, any>>(ref: Ref, args: ArgsOf<Ref>): Promise<ReturnOf<Ref>>
  runMutation<Ref extends FunctionReference<"mutation", any, any>>(ref: Ref, args: ArgsOf<Ref>): Promise<ReturnOf<Ref>>
  readonly identity: Identity | null
}

export interface LoaderArgs<Params, Search> {
  readonly params: Params
  readonly search: Search
  readonly context: LoaderContext
  readonly signal: AbortSignal
}

export interface RouteConfig<Path extends string, Loader, Search extends Record<string, unknown>> {
  /** The path pattern; the single source of truth for params (`/posts/:postId`). */
  readonly path: Path
  /** Default search object — its types drive coercion + fallbacks. */
  readonly search?: Search
  /** Prefetch reactive data for the route (returns typed data; SSR-preloadable). */
  readonly loader?: (args: LoaderArgs<PathParams<Path>, Search>) => Loader
  readonly meta?: (args: { data: Awaited<Loader>; params: PathParams<Path>; search: Search }) => MetaDescriptor
  /**
   * `false` → navigation to this route renders on the client (no server fetch);
   * the route is still server-rendered on first/direct load. Default `true`.
   */
  readonly ssr?: boolean
}

/** Per-route typed hooks, available once a framework runtime is registered. */
export interface RouteDef<Path extends string, Loader, Search extends Record<string, unknown>>
  extends RouteConfig<Path, Loader, Search> {
  readonly __params: PathParams<Path>
  readonly __loader: Awaited<Loader>
  readonly __search: Search
  useParams(): PathParams<Path>
  useSearch(): Search
  useLoaderData(): Awaited<Loader>
}

export interface LayoutConfig<Loader> {
  readonly loader?: (args: { context: LoaderContext; signal: AbortSignal }) => Loader
  readonly meta?: (args: { data: Awaited<Loader> }) => MetaDescriptor
}

export interface LayoutDef<Loader> extends LayoutConfig<Loader> {
  readonly __loader: Awaited<Loader>
  useLoaderData(): Awaited<Loader>
}

/** Framework hooks the active adapter registers (React today; Vue/Svelte later). */
export interface RouterRuntime {
  useParams(): Record<string, string>
  useSearch(): Record<string, unknown>
  useLoaderData(): unknown
}

// ── Manifest (produced by codegen) ──────────────────────────────────────────

export interface RouteManifestEntry {
  readonly pattern: string
  readonly ssr: boolean
  /** Lazy import of the page module (`{ default: Component }`) for code-splitting. */
  readonly load: () => Promise<{ default: unknown }>
  /** Lazy import of the route config module (`{ route }`). `any` to allow each
   *  route's specific param/loader types (loader params are contravariant). */
  readonly loadRoute?: () => Promise<{ route: RouteConfig<any, any, any> }>
  /** Ids (directory depth) of the layouts that wrap this route, outermost first. */
  readonly layouts: ReadonlyArray<string>
}

export interface LayoutManifestEntry {
  readonly id: string
  readonly load: () => Promise<{ default: unknown }>
  readonly loadRoute?: () => Promise<{ layout: LayoutConfig<any> }>
}

export interface RouterManifest {
  readonly routes: ReadonlyArray<RouteManifestEntry>
  readonly layouts: ReadonlyArray<LayoutManifestEntry>
}

// ── Navigation state ────────────────────────────────────────────────────────

export interface Match {
  readonly pattern: string
  readonly params: Record<string, string>
  readonly route: RouteManifestEntry
}

export interface RouterState {
  readonly href: string
  readonly pathname: string
  readonly searchString: string
  readonly match: Match | null
  readonly loaderData: Record<string, unknown>
  readonly meta: MetaDescriptor
  readonly status: "idle" | "loading"
  readonly error: unknown
}

export interface NavigateOptions {
  readonly replace?: boolean
  /** Force a client-only navigation (skip the server loader fetch). */
  readonly clientOnly?: boolean
}
