import { Effect } from "effect"
import type { Scalar } from "@rabbat/protocol"
import { BlobStore } from "../blobstore.js"
import { StorageError } from "../errors.js"
import { compareBytes, keyHex } from "../keys.js"
import type { BlockRef, Entry, SegmentFooter, SegmentRef } from "./types.js"

/** Target number of entries per block. Bigger blocks → smaller sparse index. */
export const BLOCK_ENTRIES = 64

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface WireEntry {
  k: string // hex(key)
  p: Scalar
  r: Row | null
}
type Row = Record<string, Scalar>

function encodeBlock(entries: ReadonlyArray<Entry>): Uint8Array {
  const wire: WireEntry[] = entries.map((e) => ({ k: keyHex(e.key), p: e.pk, r: e.row }))
  return encoder.encode(JSON.stringify(wire))
}

function decodeBlock(bytes: Uint8Array): Entry[] {
  const wire = JSON.parse(decoder.decode(bytes)) as WireEntry[]
  return wire.map((w) => ({ key: hexToBytes(w.k), pk: w.p, row: w.r }))
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Write a sorted run of entries to a new R2 segment object. Entries MUST already
 * be sorted by `key`. Produces the SegmentRef (with the sparse block index in
 * the footer) the manifest records.
 */
export const writeSegment = (
  storeKeyPrefix: string,
  id: string,
  level: number,
  entries: ReadonlyArray<Entry>,
): Effect.Effect<SegmentRef, StorageError, BlobStore> =>
  Effect.gen(function* () {
    const blob = yield* BlobStore
    const chunks: Uint8Array[] = []
    const blocks: BlockRef[] = []
    let offset = 0
    for (let i = 0; i < entries.length; i += BLOCK_ENTRIES) {
      const slice = entries.slice(i, i + BLOCK_ENTRIES)
      const bytes = encodeBlock(slice)
      blocks.push({ firstKey: keyHex(slice[0]!.key), offset, length: bytes.length })
      chunks.push(bytes)
      offset += bytes.length
    }
    const footer: SegmentFooter = {
      blocks,
      count: entries.length,
      minKey: entries.length ? keyHex(entries[0]!.key) : "",
      maxKey: entries.length ? keyHex(entries[entries.length - 1]!.key) : "",
    }
    const footerBytes = encoder.encode(JSON.stringify(footer))
    chunks.push(footerBytes)
    const object = concat(chunks)
    const objectKey = `${storeKeyPrefix}/${id}`
    yield* blob.put(objectKey, object)
    return {
      id,
      minKey: footer.minKey,
      maxKey: footer.maxKey,
      count: footer.count,
      footerOffset: offset,
      footerLength: footerBytes.length,
      level,
    }
  })

/** A decoded block, cached in memory keyed by `${segmentId}#${blockIndex}`. */
export interface BlockCache {
  get(key: string): Entry[] | undefined
  set(key: string, value: Entry[]): void
}

/** Read a segment's footer (the sparse index). Cached after first read. */
export const readFooter = (
  storeKeyPrefix: string,
  seg: SegmentRef,
  footerCache: Map<string, SegmentFooter>,
): Effect.Effect<SegmentFooter, StorageError, BlobStore> =>
  Effect.gen(function* () {
    const cached = footerCache.get(seg.id)
    if (cached) return cached
    const blob = yield* BlobStore
    const bytes = yield* blob.get(`${storeKeyPrefix}/${seg.id}`, {
      offset: seg.footerOffset,
      length: seg.footerLength,
    })
    if (!bytes) {
      // A referenced segment object is missing — never treat as empty (that
      // would silently drop data); surface it so the caller can recover.
      return yield* Effect.fail(
        new StorageError({ message: `segment object missing: ${storeKeyPrefix}/${seg.id}` }),
      )
    }
    const footer = JSON.parse(decoder.decode(bytes)) as SegmentFooter
    footerCache.set(seg.id, footer)
    return footer
  })

const loadBlock = (
  storeKeyPrefix: string,
  seg: SegmentRef,
  i: number,
  blk: BlockRef,
  blockCache: BlockCache,
): Effect.Effect<Entry[], StorageError, BlobStore> =>
  Effect.gen(function* () {
    const cacheKey = `${seg.id}#${i}`
    const cached = blockCache.get(cacheKey)
    if (cached) return cached
    const blob = yield* BlobStore
    const bytes = yield* blob.get(`${storeKeyPrefix}/${seg.id}`, {
      offset: blk.offset,
      length: blk.length,
    })
    if (!bytes) {
      return yield* Effect.fail(
        new StorageError({ message: `segment block missing: ${storeKeyPrefix}/${seg.id}#${i}` }),
      )
    }
    const entries = decodeBlock(bytes)
    blockCache.set(cacheKey, entries)
    return entries
  })

/**
 * Scan one segment for up to `limit` entries with key in `[lo, hi)`, in the
 * requested direction, range-GETing only the blocks the window touches (the
 * heart of cheap reads: bytes fetched ∝ window, not segment). `hi` null = open
 * upper bound. Forward returns ascending; descending returns largest-first.
 */
export const scanSegment = (
  storeKeyPrefix: string,
  seg: SegmentRef,
  lo: Uint8Array,
  hi: Uint8Array | null,
  desc: boolean,
  limit: number,
  footerCache: Map<string, SegmentFooter>,
  blockCache: BlockCache,
): Effect.Effect<Entry[], StorageError, BlobStore> =>
  Effect.gen(function* () {
    const footer = yield* readFooter(storeKeyPrefix, seg, footerCache)
    const loHex = keyHex(lo)
    const out: Entry[] = []
    // The first block that may contain `lo` is the last block whose firstKey <= lo.
    let startBlock = 0
    for (let i = 0; i < footer.blocks.length; i++) {
      if (footer.blocks[i]!.firstKey <= loHex) startBlock = i
      else break
    }
    if (!desc) {
      for (let i = startBlock; i < footer.blocks.length && out.length < limit; i++) {
        const blk = footer.blocks[i]!
        if (hi && blk.firstKey >= keyHex(hi)) break
        const entries = yield* loadBlock(storeKeyPrefix, seg, i, blk, blockCache)
        for (const e of entries) {
          if (compareBytes(e.key, lo) < 0) continue
          if (hi && compareBytes(e.key, hi) >= 0) return out
          out.push(e)
          if (out.length >= limit) return out
        }
      }
      return out
    }
    // Descending: walk blocks from the end backward, entries within a block reversed.
    let lastBlock = footer.blocks.length - 1
    if (hi) {
      const hiHex = keyHex(hi)
      lastBlock = -1
      for (let i = 0; i < footer.blocks.length; i++) {
        if (footer.blocks[i]!.firstKey < hiHex) lastBlock = i
        else break
      }
    }
    for (let i = lastBlock; i >= startBlock && out.length < limit; i--) {
      const blk = footer.blocks[i]!
      const entries = yield* loadBlock(storeKeyPrefix, seg, i, blk, blockCache)
      for (let j = entries.length - 1; j >= 0; j--) {
        const e = entries[j]!
        if (hi && compareBytes(e.key, hi) >= 0) continue
        if (compareBytes(e.key, lo) < 0) return out
        out.push(e)
        if (out.length >= limit) return out
      }
    }
    return out
  })

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
