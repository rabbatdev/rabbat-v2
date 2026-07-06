import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { aroundKey, tailWindow, type PaginationOpts, type Row, type Scalar } from "@rabbat/protocol"
import type { ArgsOf, FunctionReference, PaginatedRow, ReturnOf } from "@rabbat/functions"
import { useRabbat } from "./provider.js"

type QueryRef<Args, Return> = FunctionReference<"query", Args, Return>

/**
 * Subscribe to a reactive whole-value query. Returns `undefined` until the first
 * value arrives (or immediately if seeded by an SSR preload / cache).
 */
export function useQuery<Ref extends QueryRef<any, any>>(
  ref: Ref,
  args: ArgsOf<Ref>,
): ReturnOf<Ref> | undefined {
  const client = useRabbat()
  const argsKey = JSON.stringify(args)
  const { store, key } = useMemo(
    () => client.acquireValue<ReturnOf<Ref>>(ref.name, args as Record<string, unknown>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, ref.name, argsKey],
  )
  useEffect(() => {
    client.retain(key)
    return () => client.release(key)
  }, [client, key])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).data
}

export interface QueryResult<T> {
  readonly data: T | undefined
  readonly status: "loading" | "ready" | "error"
  /** The server error message when `status === "error"`. */
  readonly error?: string
}

/**
 * Like {@link useQuery} but also surfaces load status and subscription errors.
 * `useQuery` returns just the value; use this when you need to render an error or
 * loading state for a whole-value query.
 */
export function useQueryWithStatus<Ref extends QueryRef<any, any>>(
  ref: Ref,
  args: ArgsOf<Ref>,
): QueryResult<ReturnOf<Ref>> {
  const client = useRabbat()
  const argsKey = JSON.stringify(args)
  const { store, key } = useMemo(
    () => client.acquireValue<ReturnOf<Ref>>(ref.name, args as Record<string, unknown>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, ref.name, argsKey],
  )
  useEffect(() => {
    client.retain(key)
    return () => client.release(key)
  }, [client, key])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { data: snapshot.data, status: snapshot.status, error: snapshot.error }
}

export interface UsePaginatedQueryOptions {
  /** Initial window size and the increment used by loadOlder/loadNewer (default 30). */
  readonly initialNumItems?: number
  /** Anchor on a specific row's primary key (e.g. driven by a URL) for jump-to-item.
   *  null/omitted means the live tail (latest). */
  readonly anchor?: Scalar | null
}

export interface PaginatedResult<R> {
  readonly data: ReadonlyArray<R>
  readonly status: "loading" | "ready" | "error"
  /** The server error message when `status === "error"`. */
  readonly error?: string
  readonly total: number
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly loadOlder: () => void
  readonly loadNewer: () => void
  /** Whether the window is anchored to a key (jumped) vs. tracking the live tail. */
  readonly isAnchored: boolean
}

/**
 * Subscribe to a live, bi-directional page of a query. `loadOlder`/`loadNewer`
 * grow the window independently (infinite scroll both ways); `anchor` jumps to a
 * specific row and loads a page around it. Only diffs cross the wire.
 */
export function usePaginatedQuery<Ref extends QueryRef<any, any>>(
  ref: Ref,
  args: Omit<ArgsOf<Ref>, "paginationOpts">,
  options: UsePaginatedQueryOptions = {},
): PaginatedResult<PaginatedRow<Ref>> {
  const client = useRabbat()
  const { initialNumItems = 30, anchor = null } = options
  const argsKey = JSON.stringify(args)
  const isAnchored = anchor !== null && anchor !== undefined

  const initialWindow: PaginationOpts = isAnchored
    ? aroundKey(anchor as Exclude<Scalar, null>, initialNumItems)
    : tailWindow(initialNumItems)

  const { store, key } = useMemo(
    () => client.acquirePaginated<Row>(ref.name, args as Record<string, unknown>, initialWindow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, ref.name, argsKey, isAnchored, String(anchor), initialNumItems],
  )

  useEffect(() => {
    client.retain(key)
    return () => client.release(key)
  }, [client, key])

  // The authoritative requested window. We grow `before` and `after` on this ref
  // rather than reconstructing them from `data.length`, so the two directions
  // grow independently and two quick loadOlder clicks (before any delta lands)
  // enqueue two increments instead of one.
  const windowRef = useRef<PaginationOpts>(initialWindow)

  // Reset + re-apply the window when the subscription identity changes
  // (jump-to-item anchor change, or a new page size).
  useEffect(() => {
    windowRef.current = initialWindow
    client.setWindow(key, initialWindow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, isAnchored, String(anchor), initialNumItems])

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const loadOlder = useCallback(() => {
    const next: PaginationOpts = { ...windowRef.current, before: windowRef.current.before + initialNumItems }
    windowRef.current = next
    client.setWindow(key, next)
  }, [client, key, initialNumItems])

  const loadNewer = useCallback(() => {
    const next: PaginationOpts = { ...windowRef.current, after: windowRef.current.after + initialNumItems }
    windowRef.current = next
    client.setWindow(key, next)
  }, [client, key, initialNumItems])

  return {
    data: snapshot.data as ReadonlyArray<PaginatedRow<Ref>>,
    status: snapshot.status,
    error: snapshot.error,
    total: snapshot.total,
    hasOlder: snapshot.hasOlder,
    hasNewer: snapshot.hasNewer,
    loadOlder,
    loadNewer,
    isAnchored,
  }
}

export function useMutation<Ref extends FunctionReference<"mutation", any, any>>(
  ref: Ref,
): (args: ArgsOf<Ref>) => Promise<ReturnOf<Ref>> {
  const client = useRabbat()
  return useCallback(
    (args: ArgsOf<Ref>) => client.mutation<ReturnOf<Ref>>(ref.name, args as Record<string, unknown>),
    [client, ref.name],
  )
}

export function useAction<Ref extends FunctionReference<"action", any, any>>(
  ref: Ref,
): (args: ArgsOf<Ref>) => Promise<ReturnOf<Ref>> {
  const client = useRabbat()
  return useCallback(
    (args: ArgsOf<Ref>) => client.action<ReturnOf<Ref>>(ref.name, args as Record<string, unknown>),
    [client, ref.name],
  )
}
