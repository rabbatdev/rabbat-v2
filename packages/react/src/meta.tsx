import { useEffect, useState } from "react"
import type { MetaDescriptor } from "@rabbat/router"

// ── document <head> / <title> reconciliation ─────────────────────────────────
// One owner of the framework-managed document title: a route baseline (set by
// navigation from the matched route's `meta.title`) plus a stack of <Meta> /
// useMeta overlays (each ranked by render order so a deeper/later overlay wins).
// Any change recomputes the whole title from base + overlays, so reconciliation
// is idempotent and order-independent, and an overlay that outlives a navigation
// keeps its title until it unmounts.

/** Metadata a `<Meta>` / `useMeta` overlay can set. */
export interface PageMeta {
  readonly title?: string
  readonly description?: string
}

// The template/SSR title captured at startup — the fallback when neither the
// route nor any overlay sets a title.
let baseTitle = typeof document !== "undefined" ? document.title : ""
// The active route's baseline title (set on navigation).
let routeTitle: string | undefined
// Active overlays: render-order rank → its title (undefined = registers nothing).
const overlays = new Map<number, string | undefined>()
let seq = 0

function reconcile(): void {
  if (typeof document === "undefined") return
  let top: string | undefined
  let topRank = -1
  for (const [rank, title] of overlays) {
    if (title && rank > topRank) {
      top = title
      topRank = rank
    }
  }
  document.title = top ?? routeTitle ?? baseTitle
}

/** Set the route's baseline metadata (called by the router on navigation) and
 *  reconcile — active overlays are merged back on top, so a navigation never
 *  wipes a still-mounted component's title. No-op on the server. */
export function applyRouteMeta(meta: MetaDescriptor | undefined): void {
  if (typeof document === "undefined") return
  routeTitle = meta?.title
  reconcile()
}

// Register/unregister an overlay by render-order rank. Assigned on first render,
// so a parent (rendered before its children) gets a lower rank — a deeper/later
// overlay therefore wins.
function useMetaOverlay(title: string | undefined): void {
  const [rank] = useState(() => ++seq)
  useEffect(() => {
    overlays.set(rank, title)
    reconcile()
    return () => {
      overlays.delete(rank)
      reconcile()
    }
  }, [rank, title])
}

/**
 * Declaratively set the document title from a component (react-helmet-style) —
 * the ergonomic way to drive the title from live data:
 *
 * ```tsx
 * <Meta title={channel.name} />
 * ```
 *
 * Multiple `<Meta>`s stack by render order (a deeper/later one wins). It cleans
 * up on unmount and survives client-side navigation. Renders nothing.
 */
export function Meta(props: PageMeta): null {
  useMetaOverlay(props.title)
  return null
}

/**
 * Imperative form of {@link Meta} — set the title from a hook. Pass a string
 * (shorthand for `{ title }`) or a {@link PageMeta}. Prefer `<Meta>` in JSX.
 */
export function useMeta(meta: PageMeta | string | null | undefined): void {
  const title = meta == null ? undefined : typeof meta === "string" ? meta : meta.title
  useMetaOverlay(title)
}
