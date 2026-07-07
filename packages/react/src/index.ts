export * from "./provider.js"
export * from "./hooks.js"
export * from "./ssr.js"
export * from "./router.js"
export * from "./entry.js"
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
