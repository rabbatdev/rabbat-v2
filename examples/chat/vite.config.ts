import { defineConfig } from "vite"
import { rabbat } from "@rabbat/vite"

// One plugin wires React, the Cloudflare runtime (Durable Object + R2), and
// auto-discovery of schema.ts + functions/. `vite dev` runs the whole stack.
export default defineConfig({
  plugins: [rabbat()],
})
