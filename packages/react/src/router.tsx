import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  browserHistory,
  buildHref,
  createRouter,
  registerRouterRuntime,
  serializeSearch,
  type LoaderContext,
  type Router,
  type RouterManifest,
  type RouterState,
} from "@rabbat/router"
import type { FunctionsClient, Preload } from "@rabbat/client"
import { ClientHolderContext, type ClientHolder } from "./provider.js"

// ── Contexts ────────────────────────────────────────────────────────────────
const RouterCtx = createContext<Router | null>(null)
const StateCtx = createContext<RouterState | null>(null)
/** The loaderData key of the node currently rendering ("route" or a layout id). */
const NodeKeyCtx = createContext<string>("route")

interface LoadedNode {
  readonly key: string
  readonly Component: ComponentType
}

function useRouterState(): RouterState {
  const s = useContext(StateCtx)
  if (!s) throw new Error("rabbat router: used outside <RabbatRouter>")
  return s
}

// The framework runtime backing route.useParams()/useSearch()/useLoaderData().
registerRouterRuntime({
  useParams: () => useRouterState().match?.params ?? {},
  useSearch: () => {
    // Search defaults aren't known here; expose the raw parsed object from state.
    const s = useRouterState()
    return Object.fromEntries(new URLSearchParams(s.searchString))
  },
  useLoaderData: () => {
    const key = useContext(NodeKeyCtx)
    return useRouterState().loaderData[key]
  },
})

/** Build the browser-side loader context: `preload` seeds the client for no-flash. */
function browserLoaderContext(getClient: () => FunctionsClient | null): LoaderContext {
  const post = async (name: string, args: Record<string, unknown>, pagination?: unknown) => {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, pagination }),
    })
    return res.json() as Promise<Preload>
  }
  const value = (pre: Preload) => (pre.paginated ? pre : (pre as { value: unknown }).value) as never
  return {
    identity: null,
    preload: async (ref, args, opts) => {
      const pre = await post(ref.name, args as Record<string, unknown>, opts?.pagination)
      getClient()?.seedPreload(ref.name, args as Record<string, unknown>, pre)
      return value(pre)
    },
    runQuery: async (ref, args) => value(await post(ref.name, args as Record<string, unknown>)),
    runMutation: (ref, args) => {
      const client = getClient()
      return (client ? client.mutation(ref.name, args as Record<string, unknown>) : Promise.resolve(undefined)) as never
    },
  }
}

export interface RabbatRouterProps {
  readonly manifest: RouterManifest
  /** SSR-embedded initial state (match + loaderData), for hydration with no refetch. */
  readonly initialState?: RouterState
  /** Pre-resolved component chain for the initial route (so first render is synchronous). */
  readonly initialChain?: ReadonlyArray<LoadedNode>
}

/**
 * Renders the matched route wrapped in its layout chain, and drives navigation.
 * The providers (`<RabbatProvider>`) live in the root layout — this component is
 * mounted by the generated entry, so the user never writes `main.tsx`.
 */
export function RabbatRouter({ manifest, initialState, initialChain }: RabbatRouterProps) {
  // The client is created by <RabbatProvider> in the root layout (below us), so
  // we publish a holder it fills in; loaders read the client from it once mounted.
  const holderRef = useRef<ClientHolder>({ client: null })

  const router = useMemo(
    () =>
      createRouter({
        manifest,
        history: browserHistory(),
        makeContext: () => ({
          context: browserLoaderContext(() => holderRef.current.client),
          collectPreloads: () => ({}),
        }),
        initial: initialState ? { state: initialState } : undefined,
      }),
    [manifest, initialState],
  )

  const state = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot)
  const [chain, setChain] = useState<ReadonlyArray<LoadedNode>>(initialChain ?? [])

  // First load: if not seeded by SSR, navigate to the current URL to run loaders.
  useEffect(() => {
    if (!initialState) void router.navigate(location.pathname + location.search, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  // Whenever the match changes, resolve the component chain (cached after first load).
  const matchKey = state.match?.pattern ?? "∅"
  useEffect(() => {
    let alive = true
    void resolveChain(manifest, state).then((next) => {
      if (alive) setChain(next)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey])

  useDocumentMeta(state)

  return createElement(
    ClientHolderContext.Provider,
    { value: holderRef.current },
    createElement(
      RouterCtx.Provider,
      { value: router },
      createElement(StateCtx.Provider, { value: state }, renderChain(chain, 0)),
    ),
  )
}

async function resolveChain(manifest: RouterManifest, state: RouterState): Promise<LoadedNode[]> {
  if (!state.match) return []
  const layoutsById = new Map(manifest.layouts.map((l) => [l.id, l]))
  const nodes: LoadedNode[] = []
  for (const id of state.match.route.layouts) {
    const entry = layoutsById.get(id)
    if (!entry) continue
    const mod = await entry.load()
    nodes.push({ key: id, Component: (mod as { default: ComponentType }).default })
  }
  const page = await state.match.route.load()
  nodes.push({ key: "route", Component: (page as { default: ComponentType }).default })
  return nodes
}

function renderChain(chain: ReadonlyArray<LoadedNode>, index: number): ReactNode {
  if (index >= chain.length) return null
  const node = chain[index]!
  return createElement(
    NodeKeyCtx.Provider,
    { value: node.key },
    createElement(OutletStackCtx.Provider, { value: { chain, index } }, createElement(node.Component)),
  )
}

// ── Outlet ──────────────────────────────────────────────────────────────────
const OutletStackCtx = createContext<{ chain: ReadonlyArray<LoadedNode>; index: number } | null>(null)

/** Renders the next node in the layout chain (the child layout, or the page). */
export function Outlet(): ReactNode {
  const stack = useContext(OutletStackCtx)
  if (!stack) return null
  return renderChain(stack.chain, stack.index + 1)
}

// ── Link + navigation hooks ───────────────────────────────────────────────────
export interface RouterApi {
  navigate(href: string, opts?: { replace?: boolean }): Promise<void>
  prefetch(href: string): Promise<void>
  readonly pathname: string
}

export function useRouter(): RouterApi {
  const router = useContext(RouterCtx)
  const state = useRouterState()
  if (!router) throw new Error("rabbat router: useRouter outside <RabbatRouter>")
  return {
    navigate: (href, opts) => router.navigate(href, opts),
    prefetch: (href) => router.prefetch(href),
    pathname: state.pathname,
  }
}

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** A path pattern from your routes; pass `params` for its dynamic segments. */
  readonly to: string
  readonly params?: Record<string, string | number>
  readonly search?: Record<string, unknown>
  readonly prefetch?: boolean
  readonly children: ReactNode
}

export function Link({ to, params, search, prefetch = true, onClick, onPointerEnter, children, ...rest }: LinkProps) {
  const router = useContext(RouterCtx)
  const href = buildHref(to, params) + (search ? serializeSearch({}, search) : "")
  const go = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e)
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      void router?.navigate(href)
    },
    [router, href, onClick],
  )
  const warm = useCallback(
    (e: React.PointerEvent<HTMLAnchorElement>) => {
      onPointerEnter?.(e)
      if (prefetch) void router?.prefetch(href)
    },
    [router, href, prefetch, onPointerEnter],
  )
  return createElement("a", { href, onClick: go, onPointerEnter: warm, ...rest }, children)
}

function useDocumentMeta(state: RouterState): void {
  useEffect(() => {
    if (typeof document === "undefined") return
    if (state.meta.title !== undefined) document.title = state.meta.title
  }, [state.meta.title])
}
