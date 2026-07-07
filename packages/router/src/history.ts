export interface RouterHistory {
  location(): { pathname: string; search: string }
  push(href: string): void
  replace(href: string): void
  /** Listen for back/forward (popstate). Returns an unsubscribe. */
  listen(cb: () => void): () => void
}

/** Browser history backed by the History API + popstate. */
export function browserHistory(): RouterHistory {
  return {
    location: () => ({ pathname: location.pathname, search: location.search }),
    push: (href) => history.pushState(null, "", href),
    replace: (href) => history.replaceState(null, "", href),
    listen: (cb) => {
      const handler = () => cb()
      addEventListener("popstate", handler)
      return () => removeEventListener("popstate", handler)
    },
  }
}

/** In-memory history for SSR and tests (no DOM). */
export function memoryHistory(initialHref = "/"): RouterHistory {
  let url = new URL(initialHref, "http://localhost")
  return {
    location: () => ({ pathname: url.pathname, search: url.search }),
    push: (href) => {
      url = new URL(href, "http://localhost")
    },
    replace: (href) => {
      url = new URL(href, "http://localhost")
    },
    listen: () => () => {},
  }
}
