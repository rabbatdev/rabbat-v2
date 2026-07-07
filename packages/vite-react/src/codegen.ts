// Vite-free entry: safe to import from the CLI without pulling in vite / react plugin.
// `writeRoutes` is the standard name the rabbat CLI calls on any frontend adapter.
export { writeReactRouteCodegen, writeReactRouteCodegen as writeRoutes } from "./generate.js"
