import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { findBackendRoot } from "./discover.js"

export interface DiscoveredRoute {
  /** URL pattern, from the `path` field of the `.route.ts` (or derived from the file). */
  readonly pattern: string
  readonly ssr: boolean
  readonly routeFile: string
  readonly pageFile: string
  /** Layout ids (directory paths), outermost first. */
  readonly layouts: ReadonlyArray<string>
}

export interface DiscoveredLayout {
  readonly id: string
  readonly file: string
}

export interface RouteDiscovery {
  readonly routesDir: string
  readonly routes: ReadonlyArray<DiscoveredRoute>
  readonly layouts: ReadonlyArray<DiscoveredLayout>
}

/** The pages directory lives inside the rabbat convention root: `rabbat/pages/`. */
export function findRoutesDir(root: string): string | null {
  const backendRoot = findBackendRoot(root)
  if (backendRoot) {
    const pages = join(backendRoot, "pages")
    if (existsSync(pages)) return pages
  }
  // Fallback for apps without a backend root.
  return [join(root, "pages"), join(root, "src/pages")].find((d) => existsSync(d)) ?? null
}

/** The directory all generated code is written to (`rabbat/_generated/`). */
export function generatedDir(root: string): string {
  const backendRoot = findBackendRoot(root)
  return join(backendRoot ?? root, "_generated")
}

function parseField(src: string, field: string): string | null {
  const m = new RegExp(`${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(src)
  return m ? m[1]! : null
}

function dirChainIds(routesDir: string, fileDir: string, layoutDirs: Set<string>): string[] {
  // Layout ids = the ancestor directories (relative to routesDir) that have a _layout.
  const rel = relative(routesDir, fileDir).replace(/\\/g, "/")
  const parts = rel === "" ? [] : rel.split("/")
  const ids: string[] = []
  let acc = ""
  for (let i = 0; i <= parts.length; i++) {
    const id = i === 0 ? "" : (acc = acc ? `${acc}/${parts[i - 1]}` : parts[i - 1]!)
    if (layoutDirs.has(id)) ids.push(id)
  }
  return ids
}

export interface DiscoverRoutesOptions {
  /** The page-component file extension (`.page.tsx` for React, `.page.vue` for Vue, …). */
  readonly pageExt?: string
  /** The layout-component file name. */
  readonly layoutFile?: string
}

/** Discover `routes/`: route+page pairs and layout files. Framework-parameterized
 *  by the page/layout file conventions so each adapter can reuse it. */
export function discoverRoutes(root: string, options: DiscoverRoutesOptions = {}): RouteDiscovery | null {
  const pageExt = options.pageExt ?? ".page.tsx"
  const layoutFile = options.layoutFile ?? "_layout.tsx"
  const routesDir = findRoutesDir(root)
  if (!routesDir) return null

  const layouts: DiscoveredLayout[] = []
  const layoutDirs = new Set<string>()
  const routeFiles: Array<{ dir: string; base: string; file: string }> = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry === layoutFile) {
        const id = relative(routesDir, dir).replace(/\\/g, "/")
        layouts.push({ id, file: full })
        layoutDirs.add(id)
      } else if (entry.endsWith(".route.ts")) {
        routeFiles.push({ dir, base: entry.slice(0, -".route.ts".length), file: full })
      }
    }
  }
  walk(routesDir)

  const routes: DiscoveredRoute[] = []
  for (const rf of routeFiles) {
    const pageFile = join(rf.dir, `${rf.base}${pageExt}`)
    if (!existsSync(pageFile)) continue
    const src = readFileSync(rf.file, "utf8")
    const pattern = parseField(src, "path")
    if (!pattern) continue
    const ssr = !/ssr\s*:\s*false/.test(src)
    routes.push({ pattern, ssr, routeFile: rf.file, pageFile, layouts: dirChainIds(routesDir, rf.dir, layoutDirs) })
  }
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern))
  layouts.sort((a, b) => a.id.localeCompare(b.id))
  return { routesDir, routes, layouts }
}
