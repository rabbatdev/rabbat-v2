import type { Scalar } from "@rabbat/protocol"

/**
 * Order-preserving byte encoding for scalar tuples.
 *
 * This is the trick that lets R2 segments and the memtable be sorted *byte-wise*
 * (memcmp) yet visit rows in *logical* order: encode a tuple of column values
 * into bytes such that `compare(encode(a), encode(b)) === logicalCompare(a, b)`.
 * Index keys, the primary key, and keyset cursors all use this, so a range scan
 * over encoded keys is exactly a keyset range read — no sort step.
 */

const TAG_NULL = 0x00
const TAG_BOOL = 0x01
const TAG_NUM = 0x02 // all numbers (integral and fractional) share one ordering
const TAG_TEXT = 0x04

function pushUint64BE(out: number[], v: bigint): void {
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out.push(Number((v >> shift) & 0xffn))
  }
}

function encodeScalar(v: Scalar, out: number[]): void {
  if (v === null) {
    out.push(TAG_NULL)
    return
  }
  switch (typeof v) {
    case "boolean":
      out.push(TAG_BOOL, v ? 1 : 0)
      return
    case "number": {
      // All numbers share one tag and one ordering. The IEEE-754 order-preserving
      // transform (if negative, flip all bits; else set the sign bit) makes the
      // 64-bit pattern sort monotonically with the value — for integers and
      // fractions alike — so a column mixing 2 and 2.5 still orders correctly.
      out.push(TAG_NUM)
      const buf = new ArrayBuffer(8)
      new DataView(buf).setFloat64(0, v, false)
      let bits = new DataView(buf).getBigUint64(0, false)
      bits = bits >> 63n === 1n ? ~bits & ((1n << 64n) - 1n) : bits | (1n << 63n)
      pushUint64BE(out, bits)
      return
    }
    default: {
      // text (and base64 bytes): escape 0x00 as 0x00 0xFF, terminate with 0x00 0x00,
      // so a shorter string sorts before a longer one sharing its prefix.
      out.push(TAG_TEXT)
      const bytes = new TextEncoder().encode(v)
      for (const b of bytes) {
        out.push(b)
        if (b === 0x00) out.push(0xff)
      }
      out.push(0x00, 0x00)
      return
    }
  }
}

/** Encode a tuple of scalars into an order-preserving key. */
export function encodeKey(values: ReadonlyArray<Scalar>): Uint8Array {
  const out: number[] = []
  for (const v of values) encodeScalar(v, out)
  return Uint8Array.from(out)
}

/** Byte-wise comparison of two encoded keys (the memcmp the encoding preserves). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i]!
    const bi = b[i]!
    if (ai !== bi) return ai < bi ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * The smallest key strictly greater than every key sharing `prefix` — the
 * exclusive upper bound of a prefix group (e.g. all rows with channel_id=X).
 * Returns null when the prefix is all-0xFF (no finite upper bound).
 */
export function prefixUpperBound(prefix: Uint8Array): Uint8Array | null {
  const out = Array.from(prefix)
  while (out.length > 0) {
    const last = out[out.length - 1]!
    if (last < 0xff) {
      out[out.length - 1] = last + 1
      return Uint8Array.from(out)
    }
    out.pop()
  }
  return null
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

/** Hex string of an encoded key — used as a Map key for the memtable. */
export function keyHex(key: Uint8Array): string {
  let s = ""
  for (const b of key) s += HEX[b]!
  return s
}
