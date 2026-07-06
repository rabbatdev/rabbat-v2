import { compareBytes, keyHex } from "../keys.js"
import type { Entry } from "./types.js"

/**
 * The memtable: recent writes for one keyspace, not yet flushed to R2. Kept
 * sorted by key (binary insertion) with a hash map for O(1) overwrite. It stays
 * small — the store flushes it to an R2 segment past a threshold — so it is the
 * only part of a partition's data the Durable Object holds, and it never grows
 * toward the DO storage limit.
 */
export class Memtable {
  private readonly byKey = new Map<string, Entry>()
  private sorted: Entry[] = []
  private bytes = 0

  get size(): number {
    return this.sorted.length
  }

  /** Approximate in-memory size, used to flush by bytes rather than entry count. */
  get byteSize(): number {
    return this.bytes
  }

  upsert(entry: Entry): void {
    const hex = keyHex(entry.key)
    const cost = entryBytes(entry)
    const existing = this.byKey.get(hex)
    if (existing) {
      this.bytes += cost - entryBytes(existing)
      const idx = this.indexOf(entry.key)
      if (idx >= 0) this.sorted[idx] = entry
    } else {
      this.bytes += cost
      const idx = this.lowerBound(entry.key)
      this.sorted.splice(idx, 0, entry)
    }
    this.byKey.set(hex, entry)
  }

  get(key: Uint8Array): Entry | undefined {
    return this.byKey.get(keyHex(key))
  }

  /** Up to `limit` entries with key in `[lo, hi)`, ascending. `hi` null = open. */
  rangeForward(lo: Uint8Array, hi: Uint8Array | null, limit = Infinity): Entry[] {
    const start = this.lowerBound(lo)
    const out: Entry[] = []
    for (let i = start; i < this.sorted.length && out.length < limit; i++) {
      const e = this.sorted[i]!
      if (hi && compareBytes(e.key, hi) >= 0) break
      out.push(e)
    }
    return out
  }

  /** Up to `limit` entries with key in `[lo, hi)`, descending (largest first). */
  rangeBackward(lo: Uint8Array, hi: Uint8Array | null, limit = Infinity): Entry[] {
    const end = hi ? this.lowerBound(hi) : this.sorted.length
    const out: Entry[] = []
    for (let i = end - 1; i >= 0 && out.length < limit; i--) {
      const e = this.sorted[i]!
      if (compareBytes(e.key, lo) < 0) break
      out.push(e)
    }
    return out
  }

  all(): ReadonlyArray<Entry> {
    return this.sorted
  }

  clear(): void {
    this.byKey.clear()
    this.sorted = []
    this.bytes = 0
  }

  /** First index with key >= target. */
  private lowerBound(target: Uint8Array): number {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareBytes(this.sorted[mid]!.key, target) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private indexOf(target: Uint8Array): number {
    const idx = this.lowerBound(target)
    if (idx < this.sorted.length && compareBytes(this.sorted[idx]!.key, target) === 0) return idx
    return -1
  }
}

/** Rough byte cost of an entry: key bytes + a shallow estimate of the row. */
function entryBytes(entry: Entry): number {
  let n = entry.key.length + 16
  if (entry.row) {
    for (const k in entry.row) {
      const v = entry.row[k]
      n += k.length + (typeof v === "string" ? v.length : 8) + 8
    }
  }
  return n
}
