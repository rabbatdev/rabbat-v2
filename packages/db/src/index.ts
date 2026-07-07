/**
 * `@rabbat/db` — a flexible, **server-only** database client for Rabbat.
 *
 * For non-reactive queries/mutations outside a function context (auth adapters,
 * scripts, crons, other Workers). It connects to a partition's service-key-gated
 * admin endpoint; writes remain durable, ordered, engine-validated, and fan out
 * to live subscribers. Do NOT import this into a browser bundle.
 */
export { createRabbatDb, type RabbatDb, type DbTx } from "./client.js"
export {
  bindingTransport,
  httpTransport,
  RabbatDbError,
  type DbTransport,
  type BindingTransportOptions,
  type HttpTransportOptions,
  type DurableNamespaceLike,
  type DurableStubLike,
} from "./transport.js"
export { SERVICE_KEY_HEADER, type DbWrite, type DbRequest, type DbResponse } from "@rabbat/protocol"
