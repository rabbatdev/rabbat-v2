import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { discover, generateApi, generateWorkerEntry, generateWrangler } from "@rabbat/vite/codegen"

const COMPAT_DATE = "2025-10-01"

export function appName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }
    if (pkg.name) return pkg.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
  } catch {
    /* ignore */
  }
  return "rabbat-app"
}

/**
 * Absolute path to the deploy-ready wrangler config the Cloudflare Vite plugin
 * emits under `dist/<worker-name>/wrangler.json`. Returns the first candidate
 * that exists (the worker name defaults to the app name), or null if the build
 * hasn't produced one — so `deploy` can fail with a clear message instead of
 * handing wrangler a nonexistent `-c` path.
 */
export function distWranglerConfig(root: string): string | null {
  const base = resolve(root, "dist")
  const candidates = [
    join(base, appName(root), "wrangler.json"),
    join(base, appName(root), "wrangler.jsonc"),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Best-guess path (may not exist yet) for messaging when none is found. */
export function expectedDistWranglerConfig(root: string): string {
  return join("dist", appName(root), "wrangler.json")
}

/**
 * Generate everything an app needs from its `rabbat/schema.ts` + `rabbat/functions/`:
 * the typed `api` tree, the wired Worker + Durable Object entry, and the wrangler
 * config — all into `rabbat/_generated/`. The user imports no modules and writes
 * no wrangler/worker boilerplate.
 */
export function runCodegen(cwd: string): void {
  const disco = discover(cwd)
  const name = appName(cwd)
  mkdirSync(disco.generatedDir, { recursive: true })
  writeFileSync(join(disco.generatedDir, "worker.ts"), generateWorkerEntry(disco))
  writeFileSync(join(disco.generatedDir, "wrangler.jsonc"), generateWrangler(name, COMPAT_DATE))
  writeFileSync(join(disco.generatedDir, "api.ts"), generateApi(disco))
  // eslint-disable-next-line no-console
  console.log(`rabbat: generated api + worker for "${name}" (${disco.modules.length} modules → ${disco.generatedDir})`)
}
