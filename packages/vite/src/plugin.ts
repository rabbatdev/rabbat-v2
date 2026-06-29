import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import type { Plugin, PluginOption } from "vite"
import { discover, type Discovery } from "./discover.js"
import { generateApi, generateWorkerEntry, generateWrangler } from "./generate.js"

/** Absolute path to the generated wrangler config for a discovered backend. */
export function wranglerConfigPath(disco: Discovery): string {
  return join(disco.generatedDir, "wrangler.jsonc")
}

export interface RabbatOptions {
  /** Project root (defaults to the current working directory). */
  readonly root?: string
  /** App name for wrangler + the R2 bucket (defaults to package.json name). */
  readonly name?: string
  /** Workers compatibility date. */
  readonly compatibilityDate?: string
}

function appName(root: string, override?: string): string {
  if (override) return override
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string }
    if (pkg.name) return pkg.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
  } catch {
    /* no package.json */
  }
  return "rabbat-app"
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return
  writeFileSync(path, content)
}

function generateAll(disco: Discovery, name: string, compatDate: string): void {
  mkdirSync(disco.generatedDir, { recursive: true })
  writeIfChanged(join(disco.generatedDir, "worker.ts"), generateWorkerEntry(disco))
  writeIfChanged(join(disco.generatedDir, "wrangler.jsonc"), generateWrangler(name, compatDate))
  writeIfChanged(join(disco.generatedDir, "api.ts"), generateApi(disco))
}

/**
 * The one plugin a Rabbat app adds to its Vite config:
 *
 * ```ts
 * import { defineConfig } from "vite"
 * import { rabbat } from "@rabbat/vite"
 * export default defineConfig({ plugins: [rabbat()] })
 * ```
 *
 * It discovers `schema.ts` + `functions/`, generates the wired Worker + Durable
 * Object entry, the wrangler config, and the typed `api` tree, and wires React +
 * the Cloudflare runtime — so the user writes a schema, functions, and a React
 * app, and nothing else. `vite dev` runs the whole stack (DO + R2) on Miniflare.
 */
export function rabbat(options: RabbatOptions = {}): PluginOption {
  const root = options.root ?? process.cwd()
  const name = appName(root, options.name)
  const compatDate = options.compatibilityDate ?? "2025-10-01"

  // Generate eagerly so the wrangler config exists before the Cloudflare plugin
  // reads it during its own `config` hook.
  const disco = discover(root)
  generateAll(disco, name, compatDate)

  const regen: Plugin = {
    name: "rabbat:generate",
    buildStart() {
      generateAll(discover(root), name, compatDate)
    },
    configureServer(server) {
      const onChange = (file: string) => {
        if (file.startsWith(disco.functionsDir) && !file.includes("_generated")) {
          generateAll(discover(root), name, compatDate)
        }
      }
      server.watcher.on("add", onChange)
      server.watcher.on("unlink", onChange)
    },
  }

  return [react(), regen, cloudflare({ configPath: wranglerConfigPath(disco) })]
}
