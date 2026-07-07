import { defineConfig } from "vite"
import { rabbat } from "@rabbat/vite"
import { rabbatReact } from "@rabbat/vite-react"

// `rabbat()` is framework-agnostic (backend + the Cloudflare runtime);
// `rabbatReact()` is the React frontend adapter. Swap it for rabbatVue() /
// rabbatSvelte() to use another framework — rabbat() stays the same.
export default defineConfig({
  plugins: [rabbatReact(), rabbat()],
})
