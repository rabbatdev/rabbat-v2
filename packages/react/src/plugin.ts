// `@rabbat/react/plugin` — a thin re-export of the React adapter Vite plugin so
// an app can add it alongside the core `rabbat()` plugin without depending on
// `@rabbat/vite-react` directly:
//
//   import { rabbat } from "@rabbat/vite"
//   import { rabbatReact } from "@rabbat/react/plugin"
//   export default defineConfig({ plugins: [rabbat(), rabbatReact()] })
//
// The plugin runs @vitejs/plugin-react and provides `virtual:rabbat/manifest`.

export { rabbatReact } from "@rabbat/vite-react"
export type { RabbatReactOptions } from "@rabbat/vite-react"
