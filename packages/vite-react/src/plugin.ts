import react from "@vitejs/plugin-react"
import type { Plugin, PluginOption } from "vite"
import { writeReactRouteCodegen } from "./generate.js"

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
    buildStart() {
      gen = writeReactRouteCodegen(root)
    },
    configureServer(server) {
      const onChange = (file: string) => {
        if (!file.includes("_generated") && (file.endsWith(".route.ts") || file.endsWith("_layout.tsx") || file.endsWith(".page.tsx"))) {
          gen = writeReactRouteCodegen(root)
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
