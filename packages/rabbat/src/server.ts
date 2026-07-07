// rabbat/server → @rabbat/server. The original's `defineRoute` (an edge API
// route) maps to rabbat-v2's `defineServerRoute`.
export * from "@rabbat/server"
export { defineServerRoute as defineRoute } from "@rabbat/server"
