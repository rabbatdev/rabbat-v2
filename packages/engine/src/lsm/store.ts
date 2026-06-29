import { Context, Effect, Layer } from "effect"
import type { Scalar } from "@rabbat/protocol"
import { BlobStore } from "../blobstore.js"
import type { StorageError } from "../errors.js"
import { compareBytes, keyHex } from "../keys.js"
import { Memtable } from "./memtable.js"
import { scanSegment, writeSegment, type BlockCache } from "./segment.js"
import {
  emptyManifest,
  type Entry,
  type KeyspaceManifest,
  type Manifest,
  type SegmentFooter,
  type SegmentRef,
} from "./types.js"

/** Flush a keyspace's memtable to R2 once it holds this many entries. */
const DEFAULT_FLUSH_ENTRIES = 1024
/** Compact a keyspace's level-0 segments once there are this many. */
const DEFAULT_COMPACT_SEGMENTS = 8
const BLOCK_CACHE_CAPACITY = 512

/** The durable snapshot the Durable Object persists to its own storage. */
export interface DurableState {
  readonly manifest: Manifest
  /** Un-flushed memtable entries per keyspace (the WAL). */
  readonly memtables: Record<string, ReadonlyArray<WireEntry>>
}

interface WireEntry {
  k: string
  p: Scalar
  r: Record<string, Scalar> | null
}

class Lru implements BlockCache {
  private readonly map = new Map<string, Entry[]>()
  constructor(private readonly capacity: number) {}
  get(key: string): Entry[] | undefined {
    const v = this.map.get(key)
    if (v) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: Entry[]): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  clear(): void {
    this.map.clear()
  }
}

export interface LsmStoreApi {
  readonly lsn: () => number
  /** Apply a batch of per-keyspace entry upserts/tombstones as one commit. */
  readonly commit: (batch: ReadonlyMap<string, ReadonlyArray<Entry>>) => Effect.Effect<number, StorageError>
  /**
   * Merged scan of a keyspace over `[lo, hi)` in the requested direction, up to
   * `limit` live rows. Memtable shadows segments; newer segments shadow older;
   * tombstones are resolved out.
   */
  readonly scan: (
    keyspace: string,
    lo: Uint8Array,
    hi: Uint8Array | null,
    desc: boolean,
    limit: number,
  ) => Effect.Effect<Entry[], StorageError>
  readonly getByKey: (keyspace: string, key: Uint8Array) => Effect.Effect<Entry | null, StorageError>
  readonly maybeFlush: () => Effect.Effect<void, StorageError>
  readonly flushAll: () => Effect.Effect<void, StorageError>
  readonly dump: () => DurableState
  readonly restore: (state: DurableState) => void
  readonly stats: () => { segments: number; memtableEntries: number }
}

export class LsmStore extends Context.Service<LsmStore, LsmStoreApi>()("rabbat/LsmStore") {}

export interface LsmConfig {
  readonly prefix: string
  readonly flushEntries?: number
  readonly compactSegments?: number
}

export const LsmStoreLive = (config: LsmConfig): Layer.Layer<LsmStore, never, BlobStore> =>
  Layer.effect(
    LsmStore,
    Effect.gen(function* () {
      const blob = yield* BlobStore
      const flushEntries = config.flushEntries ?? DEFAULT_FLUSH_ENTRIES
      const compactSegments = config.compactSegments ?? DEFAULT_COMPACT_SEGMENTS

      const memtables = new Map<string, Memtable>()
      const footerCache = new Map<string, SegmentFooter>()
      const blockCache = new Lru(BLOCK_CACHE_CAPACITY)
      let manifest: Manifest = emptyManifest()
      let segCounter = 0

      const memtableFor = (ks: string): Memtable => {
        let m = memtables.get(ks)
        if (!m) {
          m = new Memtable()
          memtables.set(ks, m)
        }
        return m
      }

      const ksManifest = (ks: string): KeyspaceManifest => manifest.keyspaces[ks] ?? { segments: [] }

      const nextSegId = (): string => `seg-${manifest.lsn}-${segCounter++}`

      const segOverlaps = (seg: SegmentRef, loHex: string, hiHex: string | null): boolean =>
        seg.count > 0 && seg.maxKey >= loHex && (hiHex === null || seg.minKey < hiHex)

      /** Merge per-source candidate lists; newest source wins per key; drop tombstones. */
      const mergeCandidates = (
        sources: ReadonlyArray<ReadonlyArray<Entry>>,
        desc: boolean,
        limit: number,
      ): Entry[] => {
        // sources[0] = newest (memtable), ascending priority by index.
        const best = new Map<string, { e: Entry; pri: number }>()
        for (let pri = 0; pri < sources.length; pri++) {
          for (const e of sources[pri]!) {
            const hex = keyHex(e.key)
            const cur = best.get(hex)
            if (!cur || pri < cur.pri) best.set(hex, { e, pri })
          }
        }
        const live = [...best.values()].map((v) => v.e).filter((e) => e.row !== null)
        live.sort((a, b) => (desc ? -compareBytes(a.key, b.key) : compareBytes(a.key, b.key)))
        return live.slice(0, limit)
      }

      const scan = (
        keyspace: string,
        lo: Uint8Array,
        hi: Uint8Array | null,
        desc: boolean,
        limit: number,
      ): Effect.Effect<Entry[], StorageError, BlobStore> =>
        Effect.gen(function* () {
          const loHex = keyHex(lo)
          const hiHex = hi ? keyHex(hi) : null
          const segs = ksManifest(keyspace).segments.filter((s) => segOverlaps(s, loHex, hiHex))
          // Over-read per source, retry with a larger cap if truncation could hide rows.
          let cap = Math.max(limit, 16)
          for (let attempt = 0; attempt < 8; attempt++) {
            const mem = memtableFor(keyspace)
            const memCands = desc ? mem.rangeBackward(lo, hi, cap) : mem.rangeForward(lo, hi, cap)
            const sources: Entry[][] = [memCands]
            let truncated = memCands.length >= cap
            for (const seg of segs) {
              const got = yield* scanSegment(
                keyspace,
                seg,
                lo,
                hi,
                desc,
                cap,
                footerCache,
                blockCache,
              )
              sources.push(got)
              if (got.length >= cap) truncated = true
            }
            const merged = mergeCandidates(sources, desc, limit)
            if (merged.length >= limit || !truncated) return merged
            cap *= 4
          }
          // Fallback after max attempts: best effort with the last cap.
          return mergeCandidates([memtableFor(keyspace).all()], desc, limit)
        })

      const successor = (key: Uint8Array): Uint8Array => {
        const out = new Uint8Array(key.length + 1)
        out.set(key, 0)
        out[key.length] = 0x00
        return out
      }

      const getByKey = (
        keyspace: string,
        key: Uint8Array,
      ): Effect.Effect<Entry | null, StorageError, BlobStore> =>
        Effect.gen(function* () {
          const rows = yield* scan(keyspace, key, successor(key), false, 1)
          const hit = rows[0]
          if (hit && compareBytes(hit.key, key) === 0) return hit
          return null
        })

      const flushKeyspace = (ks: string): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          const mem = memtableFor(ks)
          if (mem.size === 0) return
          const entries = [...mem.all()]
          const ref = yield* writeSegment(ks, nextSegId(), 0, entries)
          const prev = ksManifest(ks)
          manifest = {
            ...manifest,
            keyspaces: { ...manifest.keyspaces, [ks]: { segments: [ref, ...prev.segments] } },
          }
          mem.clear()
          yield* maybeCompact(ks)
        })

      const maybeCompact = (ks: string): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          const segs = ksManifest(ks).segments
          const level0 = segs.filter((s) => s.level === 0)
          if (level0.length < compactSegments) return
          // Merge all overlapping segments into one compacted run, newest wins.
          const lists: Entry[][] = []
          for (const seg of segs) {
            lists.push(
              yield* scanSegment(ks, seg, new Uint8Array(), null, false, Infinity, footerCache, blockCache),
            )
          }
          const merged = mergeCandidates(lists, false, Infinity) // tombstones dropped on full compaction
          const ref = yield* writeSegment(ks, nextSegId(), 1, merged)
          manifest = {
            ...manifest,
            keyspaces: { ...manifest.keyspaces, [ks]: { segments: [ref] } },
          }
          // Old segment objects are now unreferenced; delete to reclaim R2.
          for (const seg of segs) {
            footerCache.delete(seg.id)
            yield* blob.delete(`${ks}/${seg.id}`)
          }
        })

      const commit = (
        batch: ReadonlyMap<string, ReadonlyArray<Entry>>,
      ): Effect.Effect<number, StorageError, BlobStore> =>
        Effect.gen(function* () {
          for (const [ks, entries] of batch) {
            const mem = memtableFor(ks)
            for (const e of entries) mem.upsert(e)
          }
          manifest = { ...manifest, lsn: manifest.lsn + 1 }
          yield* maybeFlush()
          return manifest.lsn
        })

      const maybeFlush = (): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          for (const [ks, mem] of memtables) {
            if (mem.size >= flushEntries) yield* flushKeyspace(ks)
          }
        })

      const flushAll = (): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          for (const ks of memtables.keys()) yield* flushKeyspace(ks)
        })

      const dump: LsmStoreApi["dump"] = () => {
        const out: Record<string, WireEntry[]> = {}
        for (const [ks, mem] of memtables) {
          out[ks] = mem.all().map((e) => ({ k: keyHex(e.key), p: e.pk, r: e.row }))
        }
        return { manifest, memtables: out }
      }

      const restore: LsmStoreApi["restore"] = (state) => {
        manifest = state.manifest
        memtables.clear()
        footerCache.clear()
        blockCache.clear()
        for (const [ks, wire] of Object.entries(state.memtables)) {
          const mem = memtableFor(ks)
          for (const w of wire) mem.upsert({ key: hexToBytes(w.k), pk: w.p, row: w.r })
        }
      }

      // The internal effects pull BlobStore from context; discharge it at the
      // service boundary with the already-resolved `blob` so callers see no
      // BlobStore requirement.
      const withBlob = <A, E>(eff: Effect.Effect<A, E, BlobStore>): Effect.Effect<A, E> =>
        Effect.provideService(eff, BlobStore, blob)

      return {
        lsn: () => manifest.lsn,
        commit: (batch) => withBlob(commit(batch)),
        scan: (ks, lo, hi, desc, limit) => withBlob(scan(ks, lo, hi, desc, limit)),
        getByKey: (ks, key) => withBlob(getByKey(ks, key)),
        maybeFlush: () => withBlob(maybeFlush()),
        flushAll: () => withBlob(flushAll()),
        dump,
        restore,
        stats: () => ({
          segments: Object.values(manifest.keyspaces).reduce((n, k) => n + k.segments.length, 0),
          memtableEntries: [...memtables.values()].reduce((n, m) => n + m.size, 0),
        }),
      }
    }),
  )

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
