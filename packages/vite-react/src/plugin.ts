import path from "node:path"
import react from "@vitejs/plugin-react"
import type { Plugin, PluginOption } from "vite"
import { writeReactRouteCodegen } from "./generate.js"
import { generateClientManifest } from "./pages-manifest.js"

const MANIFEST = "virtual:rabbat/manifest"
const RESOLVED_MANIFEST = "\0" + MANIFEST

export interface RabbatReactOptions {
  readonly root?: string
  /** Options forwarded to @vitejs/plugin-react. */
  readonly react?: Parameters<typeof react>[0]
}

/**
 * The React frontend adapter. Pair it with the framework-agnostic `rabbat()`:
 *
 * ```ts
 * import { defineConfig } from "vite"
 * import { rabbat } from "@rabbat/vite"
 * import { rabbatReact } from "@rabbat/vite-react"
 * export default defineConfig({ plugins: [rabbatReact(), rabbat()] })
 * ```
 *
 * It runs `@vitejs/plugin-react`, discovers `src/routes/`, generates the route
 * manifest + the typed React `Link` + the client entry (so there's no
 * `main.tsx`), and injects the entry into index.html. A Vue/Svelte app would use
 * `rabbatVue()`/`rabbatSvelte()` here instead — `rabbat()` stays the same.
 */
export function rabbatReact(options: RabbatReactOptions = {}): PluginOption {
  const root = options.root ?? process.cwd()
  let gen = writeReactRouteCodegen(root)

  const plugin: Plugin = {
    name: "rabbat:react",
    config() {
      // `@rabbat/react/entry-client` imports `react-dom/client`; force it into
      // optimizeDeps so its CJS→ESM interop is applied for every consumer.
      return { optimizeDeps: { include: ["react-dom/client"] } }
    },
    buildStart() {
      gen = writeReactRouteCodegen(root)
    },
    resolveId(id) {
      // `virtual:rabbat/manifest` — the client page table scanned from `pages/`.
      if (id === MANIFEST) return RESOLVED_MANIFEST
      return null
    },
    load(id) {
      if (id === RESOLVED_MANIFEST) return generateClientManifest(root)
      return null
    },
    configureServer(server) {
      const pagesChanged = (file: string) => {
        const p = file.split(path.sep).join("/")
        return p.includes("/pages/") && (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".jsx"))
      }
      const onChange = (file: string) => {
        if (!file.includes("_generated") && (file.endsWith(".route.ts") || file.endsWith("_layout.tsx") || file.endsWith(".page.tsx"))) {
          gen = writeReactRouteCodegen(root)
        }
        // Re-scan the client manifest when a page/layout/route under pages/ changes.
        if (pagesChanged(file)) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_MANIFEST)
          if (mod) server.moduleGraph.invalidateModule(mod)
          server.ws.send({ type: "full-reload" })
        }
      }
      server.watcher.on("add", onChange)
      server.watcher.on("unlink", onChange)
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!gen || html.includes(gen.entryUrl)) return html
        return html.replace("</body>", `  <script type="module" src="${gen.entryUrl}"></script>\n</body>`)
      },
    },
  }

  return [react(options.react), plugin]
}
