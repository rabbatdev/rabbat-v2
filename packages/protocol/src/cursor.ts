import type { OrderKey, Row, Scalar } from "./values.js"
import { compareScalar, keyOf } from "./values.js"

/**
 * A keyset cursor: the effective sort-key tuple of a row (order-by columns plus
 * the primary key appended as a tiebreaker). Cursors are opaque to clients and
 * round-trip independently of storage position — a row read at a given cursor
 * always sorts to the same place, even as rows are inserted or deleted around
 * it. That stability is what makes bi-directional infinite scroll and
 * jump-to-item work.
 */
export interface Cursor {
  readonly key: Scalar[]
}

/** URL-safe base64 without padding (matches the reference encoding). */
function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  // btoa is available in workerd, browsers and Node 18+.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(encoder.encode(JSON.stringify(cursor.key)))
}

/** Bounds on client-supplied cursors: they cross the trust boundary. */
const MAX_CURSOR_CHARS = 8192
const MAX_CURSOR_ELEMENTS = 32

const isScalar = (v: unknown): v is Scalar =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v))

/** Thrown for any malformed/forged cursor — safe to surface to the client. */
export class CursorError extends Error {
  override readonly name = "CursorError"
}

/**
 * Decode and validate an untrusted cursor. Every element must be a finite
 * scalar (string/finite number/boolean/null) — anything else (objects, arrays,
 * `undefined`, non-finite numbers) would corrupt the key encoding downstream.
 * When `arity` is given, the key must have exactly that many elements (the
 * query's effective order length), so a cursor cannot be transplanted between
 * queries of different shape or seek with a truncated/extended key.
 */
export function decodeCursor(s: string, arity?: number): Cursor {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_CURSOR_CHARS) {
    throw new CursorError("bad cursor: invalid length")
  }
  let key: unknown
  try {
    key = JSON.parse(decoder.decode(fromBase64Url(s)))
  } catch {
    throw new CursorError("bad cursor: not decodable")
  }
  if (!Array.isArray(key) || key.length === 0 || key.length > MAX_CURSOR_ELEMENTS) {
    throw new CursorError("bad cursor: not a key tuple")
  }
  if (!key.every(isScalar)) throw new CursorError("bad cursor: non-scalar element")
  if (arity !== undefined && key.length !== arity) {
    throw new CursorError(`bad cursor: expected ${arity} element(s), got ${key.length}`)
  }
  return { key: key as Scalar[] }
}

/** Build the cursor for a row under an effective order. */
export function cursorFor(row: Row, order: ReadonlyArray<OrderKey>): Cursor {
  return { key: keyOf(row, order) }
}

/**
 * Compare a row against a cursor key under an effective order. Returns <0 if the
 * row sorts before the cursor, 0 if equal, >0 if after — direction-aware.
 */
export function compareRowToCursor(
  row: Row,
  cursorKey: ReadonlyArray<Scalar>,
  order: ReadonlyArray<OrderKey>,
): number {
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!
    const c = compareScalar(row[k.column] ?? null, cursorKey[i] ?? null)
    if (c !== 0) return k.desc ? -c : c
  }
  return 0
}
