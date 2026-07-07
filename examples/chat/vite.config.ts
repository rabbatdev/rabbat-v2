import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { rabbatPlugin } from "rabbat/plugin";
import { rabbatReact } from "@rabbat/react/plugin";
import tailwindcss from "@tailwindcss/vite";

// A unique id per build, baked into the bundle (`__BUILD_ID__`) and written to
// `version.json`. The running client polls version.json and compares ids to know
// a newer deploy is live (use-version-check + UpdateToast). Railway sets a fresh
// value each deploy; locally it's the build timestamp.
const BUILD_ID = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.BUILD_ID ?? Date.now().toString(36);

function emitVersion(): Plugin {
  return {
    name: "emit-version",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ id: BUILD_ID }) });
    },
  };
}

// Rabbat drives the whole stack (`rabbat dev` / `build` / `start`): the database,
// the /functions WebSocket, file-based pages/ + api/, and SSR — one port, no proxy.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [rabbatPlugin(), rabbatReact(), tailwindcss(), emitVersion()],
  // `@rabbat/react`'s entry-client imports `react-dom/client`. Consumed from npm
  // its source isn't scanned by Vite's dep optimizer, so react-dom/client is
  // served as raw CJS and its `createRoot`/`hydrateRoot` named exports break.
  // Pre-bundle it so the ESM interop is applied. (Newer @rabbat/react does this
  // in its Vite plugin — see rabbatReact's `config` hook.)
  optimizeDeps: { include: ["react-dom/client"] },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
