import { Schema } from "effect"
import { PaginationOpts } from "./pagination.js"
import type { OrderKey, Row, Scalar } from "./values.js"

/**
 * Free-form JSON arguments to a function call. Validated structurally by each
 * function's own `v.*` validators once dispatched; at the envelope level we only
 * require an object.
 */
export const Args = Schema.Record(Schema.String, Schema.Unknown)
export type Args = Record<string, unknown>

/**
 * Client → server messages. These cross the trust boundary, so they are decoded
 * with Effect Schema; a malformed frame is rejected before it reaches any
 * handler.
 */
export const ClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("setAuth"),
    token: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    sub: Schema.String,
    name: Schema.String,
    args: Args,
    pagination: Schema.optional(PaginationOpts),
  }),
  Schema.Struct({
    type: Schema.Literal("setPagination"),
    sub: Schema.String,
    pagination: PaginationOpts,
  }),
  Schema.Struct({
    type: Schema.Literal("unsubscribe"),
    sub: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("mutation"),
    id: Schema.Number,
    name: Schema.String,
    args: Args,
  }),
  Schema.Struct({
    type: Schema.Literal("action"),
    id: Schema.Number,
    name: Schema.String,
    args: Args,
  }),
  Schema.Struct({ type: Schema.Literal("ping"), id: Schema.Number }),
])
export type ClientMessage = typeof ClientMessage.Type

export const decodeClientMessage = Schema.decodeUnknownSync(ClientMessage)

/**
 * Server → client messages. We construct these, so they are plain types rather
 * than decoded schemas. Every data-bearing message carries a `watermark` — the
 * partition commit LSN the payload reflects — so the client and the SSR layer
 * can resume a live subscription exactly where a snapshot left off, and the
 * cache can answer conditional reads.
 */
export type ServerMessage =
  | {
      readonly type: "subscribed"
      readonly sub: string
      readonly paginated: boolean
      readonly pk?: string
      readonly order?: ReadonlyArray<OrderKey>
    }
  /** A whole-value (non-paginated) query result. */
  | {
      readonly type: "value"
      readonly sub: string
      readonly value: unknown
      readonly watermark: number
    }
  /** An incremental page diff — only changed rows and departed keys. */
  | {
      readonly type: "pageDelta"
      readonly sub: string
      readonly upserts: ReadonlyArray<Row>
      readonly removes: ReadonlyArray<Scalar>
      readonly hasOlder: boolean
      readonly hasNewer: boolean
      readonly total: number
      readonly watermark: number
    }
  | { readonly type: "mutationResult"; readonly id: number; readonly value: unknown }
  | { readonly type: "actionResult"; readonly id: number; readonly value: unknown }
  | {
      readonly type: "error"
      readonly id?: number | null
      readonly sub?: string | null
      readonly message: string
    }
  | { readonly type: "pong"; readonly id: number }

/**
 * The payload shape shared by a one-shot HTTP query response and the body of a
 * `pageDelta`. A paginated read returns this; a conditional read may instead get
 * a 304 carrying just the watermark.
 */
export interface PageResult {
  readonly rows: ReadonlyArray<Row>
  readonly pk: string
  readonly order: ReadonlyArray<OrderKey>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly total: number
  readonly watermark: number
}
