import { createElement } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import type { RouterManifest, RouterState } from "@rabbat/router"
import { RabbatRouter } from "./router.js"

export interface MountOptions {
  readonly manifest: RouterManifest
  /** DOM id to mount into (default "root"). */
  readonly rootId?: string
}

interface SsrPayload {
  readonly state: RouterState
}

/**
 * Mount the app. The generated entry calls this, so the user never writes
 * `main.tsx` — they just put `<RabbatProvider>` (and any other providers) in
 * `routes/_layout.tsx`. If the server embedded an SSR snapshot, hydrate it;
 * otherwise render fresh on the client.
 */
export function mountRabbatApp({ manifest, rootId = "root" }: MountOptions): void {
  const el = document.getElementById(rootId)
  if (!el) throw new Error(`rabbat: #${rootId} not found`)

  const ssrEl = document.getElementById("__rabbat_ssr__")
  if (ssrEl?.textContent) {
    const payload = JSON.parse(ssrEl.textContent) as SsrPayload
    hydrateRoot(el, createElement(RabbatRouter, { manifest, initialState: payload.state }))
  } else {
    createRoot(el).render(createElement(RabbatRouter, { manifest }))
  }
}
