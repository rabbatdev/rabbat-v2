// Vite-free entry: pure Node discovery + generation, safe to import from the CLI
// or a framework adapter without pulling in vite / @cloudflare/vite-plugin.
export { discover, findBackendRoot, type Discovery, type ModuleFile } from "./discover.js"
export { generateApi, generateWorkerEntry, generateWrangler } from "./generate.js"
export {
  discoverRoutes,
  findRoutesDir,
  generatedDir,
  type RouteDiscovery,
  type DiscoverRoutesOptions,
} from "./routes.js"
export { generateManifest, generateRoutesInterface, routeSpec, paramsType } from "./generate-routes.js"
