import { type CompiledPattern, compilePattern, matchPattern } from "./params.js"
import type { Match, RouterManifest } from "./types.js"

export interface CompiledRoute {
  readonly compiled: CompiledPattern
  readonly entry: RouterManifest["routes"][number]
}

/** Compile + rank the manifest's routes (most specific first). */
export function compileRoutes(manifest: RouterManifest): CompiledRoute[] {
  return manifest.routes
    .map((entry) => ({ entry, compiled: compilePattern(entry.pattern) }))
    .sort((a, b) => b.compiled.score - a.compiled.score)
}

export function matchRoute(routes: ReadonlyArray<CompiledRoute>, pathname: string): Match | null {
  for (const { entry, compiled } of routes) {
    const params = matchPattern(compiled, pathname)
    if (params) return { pattern: entry.pattern, params, route: entry }
  }
  return null
}
