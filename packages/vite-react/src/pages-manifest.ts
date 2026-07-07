// Scans a `pages/` directory (index.tsx / layout.tsx / route.ts convention) and
// generates the client page table that `virtual:rabbat/manifest` exports:
//
//   export const pages = [ { pattern, load, loadRoute, layouts }, ... ]
//   export const manifest = { pages }
//
// Conventions:
//   index.tsx        → parent path       (pages/index.tsx → /)
//   [id]             → :id dynamic seg   (pages/o/[orbitId]/index.tsx → /o/:orbitId)
//   [...slug]        → *slug catch-all
//   (group)          → omitted from URL
//   layout.tsx       → wraps every page at or below its directory (outermost first)
//   route.ts         → the folder's `index` page companion (`{ Route }`)

import fs from "node:fs"
import path from "node:path"

const COMPONENT_EXT = /\.(tsx|jsx)$/
const ROUTE_FILE = /(^|\/)route\.(ts|tsx)$/
const EXT = /\.(tsx|ts|jsx|js|mjs)$/

/** Convert a file path (relative to pages/, no leading slash) to a URL pattern,
 *  or null if the file is private (`_`-prefixed segment). */
export function fileToPattern(rel: string): string | null {
  const noExt = rel.replace(/\\/g, "/").replace(EXT, "")
  const out: string[] = []
  for (const seg of noExt.split("/").filter(Boolean)) {
    if (seg.startsWith("_")) return null
    if (/^\(.*\)$/.test(seg)) continue // route group
    if (seg === "index") continue // index → parent
    const catchAll = seg.match(/^\[\.\.\.(.+)\]$/)
    if (catchAll) {
      out.push("*" + catchAll[1])
      continue
    }
    const dyn = seg.match(/^\[(.+)\]$/)
    if (dyn) {
      out.push(":" + dyn[1])
      continue
    }
    out.push(seg)
  }
  return "/" + out.join("/")
}

interface ScannedPage {
  pattern: string
  component: string
  route: string | null
  layouts: string[]
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // `_`/`.` = private; `$` = generated framework neighbors (e.g. `$route.ts`).
    if (e.name.startsWith("_") || e.name.startsWith(".") || e.name.startsWith("$")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const rel = (base: string, abs: string) => path.relative(base, abs).split(path.sep).join("/")

/** Locate the `pages/` directory for a project root (root/pages or root/src/pages). */
export function findPagesDir(root: string): string | null {
  return [path.join(root, "pages"), path.join(root, "src", "pages")].find((d) => fs.existsSync(d)) ?? null
}

export function scanPages(pagesDir: string): ScannedPage[] {
  const pages: ScannedPage[] = []
  const routeForDir = new Map<string, string>()
  const layouts = new Map<string, string>()
  const dirOf = (r: string) => (r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "")

  const pageFiles = walk(pagesDir)
  for (const abs of pageFiles) {
    const r = rel(pagesDir, abs)
    if (ROUTE_FILE.test(r)) routeForDir.set(dirOf(r), "/pages/" + r)
  }

  const isCompanion = (r: string) => ROUTE_FILE.test(r)

  // Pass 1 — register every layout.tsx by the directory it governs.
  for (const abs of pageFiles) {
    const r = rel(pagesDir, abs)
    if (isCompanion(r) || !COMPONENT_EXT.test(r)) continue
    const base = r.replace(COMPONENT_EXT, "")
    if (base === "layout") layouts.set("", "/pages/" + r)
    else if (base.endsWith("/layout")) layouts.set(base.slice(0, -"/layout".length), "/pages/" + r)
  }

  const chainFor = (r: string): string[] => {
    const slash = r.lastIndexOf("/")
    const dir = slash === -1 ? "" : r.slice(0, slash)
    const chain: string[] = []
    const rootLayout = layouts.get("")
    if (rootLayout) chain.push(rootLayout)
    if (dir) {
      let prefix = ""
      for (const seg of dir.split("/")) {
        prefix = prefix ? prefix + "/" + seg : seg
        const l = layouts.get(prefix)
        if (l) chain.push(l)
      }
    }
    return chain
  }

  // Pass 2 — pages (layouts excluded), each carrying its resolved layout chain.
  for (const abs of pageFiles) {
    const r = rel(pagesDir, abs)
    if (isCompanion(r) || !COMPONENT_EXT.test(r)) continue
    const base = r.replace(COMPONENT_EXT, "")
    if (base === "layout" || base.endsWith("/layout")) continue
    const pattern = fileToPattern(r)
    if (pattern === null) continue
    const isIndex = base === "index" || base.endsWith("/index")
    pages.push({
      pattern,
      component: "/pages/" + r,
      route: isIndex ? (routeForDir.get(dirOf(r)) ?? null) : null,
      layouts: chainFor(r),
    })
  }

  return pages
}

const J = (s: string) => JSON.stringify(s)
const genLayouts = (ls: string[]) => `[${ls.map((l) => `() => import(${J(l)})`).join(", ")}]`

/** Generate the `virtual:rabbat/manifest` module source for a project root. */
export function generateClientManifest(root: string): string {
  const pagesDir = findPagesDir(root)
  const scanned = pagesDir ? scanPages(pagesDir) : []
  const pages = scanned
    .map(
      (p) =>
        `  { pattern: ${J(p.pattern)}, load: () => import(${J(p.component)}), loadRoute: ${
          p.route ? `() => import(${J(p.route)})` : "null"
        }, layouts: ${genLayouts(p.layouts)} }`,
    )
    .join(",\n")
  return `export const pages = [\n${pages}\n];\nexport const manifest = { pages };\n`
}
