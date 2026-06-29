import { defineConfig } from "vitest/config"

// A plain Node test config so the unit tests don't load the app's Cloudflare
// Vite plugin. The tests exercise the real functions through the Runtime/engine.
export default defineConfig({
  test: { environment: "node" },
})
