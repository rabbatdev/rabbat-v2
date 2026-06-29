import { Schema } from "effect"
import type { Scalar } from "./values.js"

/**
 * Where a live window is anchored:
 *  - `latest`   — the live tail (newest rows; a chat feed bottom)
 *  - `earliest` — the start of the result
 *  - `cursor`   — a specific position (opaque keyset cursor)
 *  - `key`      — a specific row by primary key ("jump to message")
 */
export const Anchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("latest") }),
  Schema.Struct({ kind: Schema.Literal("earliest") }),
  Schema.Struct({ kind: Schema.Literal("cursor"), cursor: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    key: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  }),
])
export type Anchor = typeof Anchor.Type

/**
 * A live, bi-directional window: load `before` rows before the anchor and
 * `after` rows at/after it. Growing `before`/`after` independently is what makes
 * scrolling infinite in both directions; moving the `anchor` is jump-to-item.
 */
export const PaginationOpts = Schema.Struct({
  before: Schema.Number,
  after: Schema.Number,
  anchor: Anchor,
})
export type PaginationOpts = typeof PaginationOpts.Type

/** Default tail window: a page of the newest rows. */
export const tailWindow = (n: number): PaginationOpts => ({
  before: n,
  after: 0,
  anchor: { kind: "latest" },
})

/** Default head window: a page from the earliest rows. */
export const headWindow = (n: number): PaginationOpts => ({
  before: 0,
  after: n,
  anchor: { kind: "earliest" },
})

/** A window centered on a specific row, for jump-to-item. */
export const aroundKey = (key: Exclude<Scalar, null>, half: number): PaginationOpts => ({
  before: half,
  after: half,
  anchor: { kind: "key", key },
})
