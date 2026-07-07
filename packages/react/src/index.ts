export * from "./provider.js"
export * from "./hooks.js"
export * from "./ssr.js"
export * from "./router.js"
export * from "./meta.js"
export * from "./entry.js"
// The client page-manifest shape (`virtual:rabbat/manifest`) + its adapter.
export type { PageManifestClientEntry, ClientManifest } from "./manifest.js"

// Re-export the route authoring API so apps import everything from @rabbat/react.
export {
  defineRoute,
  defineLayout,
  defineServerRoute,
  HandlerBuilder,
  type RouteDef,
  type LayoutDef,
  type LoaderContext,
  type ServerContext,
  type MetaDescriptor,
  type RouterManifest,
} from "@rabbat/router"

// Ergonomic function-type helpers: name a function's args/return off the `api`
// tree, e.g. `type Member = FunctionReturns<typeof api.members.list>[number]`.
export type {
  FunctionReference,
  FunctionArgs,
  FunctionReturns,
  ArgsOf,
  ReturnOf,
  PaginatedRow,
} from "@rabbat/functions"
