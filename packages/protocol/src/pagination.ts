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
 * Hard protocol ceiling for one side of a window. This bounds the rows a single
 * subscription can force the partition DO to materialize in memory — a client
 * asking for more is rejected at decode, before any engine work. Servers may
 * clamp lower; they can never accept more.
 */
export const MAX_WINDOW_SIDE = 1000

/** A window side: a non-negative integer no larger than `MAX_WINDOW_SIDE`. */
const WindowSide = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: MAX_WINDOW_SIDE }),
)

/**
 * A live, bi-directional window: load `before` rows before the anchor and
 * `after` rows at/after it. Growing `before`/`after` independently is what makes
 * scrolling infinite in both directions; moving the `anchor` is jump-to-item.
 */
export const PaginationOpts = Schema.Struct({
  before: WindowSide,
  after: WindowSide,
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
