import { Context, Effect, Layer } from "effect"
import type { Scalar } from "@rabbat/protocol"
import { BlobStore } from "../blobstore.js"
import { StorageError } from "../errors.js"
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
/** Or once it reaches this many bytes (whichever comes first) — keeps the DO's
 * per-value storage well under platform limits regardless of row size. */
const DEFAULT_FLUSH_BYTES = 4 * 1024 * 1024
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
   * Delete R2 objects superseded by compaction. MUST be called only after the
   * new manifest has been made durable (persisted) — deleting earlier risks a
   * crash leaving the persisted manifest pointing at objects that no longer
   * exist. Safe to call repeatedly; a no-op when nothing is pending.
   */
  readonly gc: () => Effect.Effect<void, StorageError>
  /**
   * Mirror the manifest to R2 (tiny) for disaster recovery: if the DO's own
   * storage is ever lost, the segment layout is still discoverable in the bucket.
   */
  readonly mirrorManifest: () => Effect.Effect<void, StorageError>
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
  readonly flushBytes?: number
  readonly compactSegments?: number
}

export const LsmStoreLive = (config: LsmConfig): Layer.Layer<LsmStore, never, BlobStore> =>
  Layer.effect(
    LsmStore,
    Effect.gen(function* () {
      const blob = yield* BlobStore
      const flushEntries = config.flushEntries ?? DEFAULT_FLUSH_ENTRIES
      const flushBytes = config.flushBytes ?? DEFAULT_FLUSH_BYTES
      const compactSegments = config.compactSegments ?? DEFAULT_COMPACT_SEGMENTS
      // Namespace every R2 object under this store's prefix so partitions (and
      // tenants) sharing one bucket can never read, overwrite, or delete each
      // other's segments.
      const prefix = config.prefix.replace(/\/+$/, "")
      const objectPrefix = (ks: string): string => (prefix ? `${prefix}/${ks}` : ks)

      const memtables = new Map<string, Memtable>()
      const footerCache = new Map<string, SegmentFooter>()
      const blockCache = new Lru(BLOCK_CACHE_CAPACITY)
      // R2 object keys superseded by compaction, awaiting a durable manifest
      // before they can be safely deleted (see `gc`).
      const pendingDeletes = new Set<string>()
      let manifest: Manifest = emptyManifest()

      const memtableFor = (ks: string): Memtable => {
        let m = memtables.get(ks)
        if (!m) {
          m = new Memtable()
          memtables.set(ks, m)
        }
        return m
      }

      const ksManifest = (ks: string): KeyspaceManifest => manifest.keyspaces[ks] ?? { segments: [] }

      /**
       * Segment ids come from a counter persisted in the manifest: after a
       * restore the counter resumes past every id the manifest references, so a
       * new segment can never overwrite a live R2 object.
       */
      const nextSegId = (): string => {
        const seq = manifest.seq + 1
        manifest = { ...manifest, seq }
        return `seg-${seq}`
      }

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

      /**
       * Like {@link mergeCandidates} but preserves tombstones — used by an
       * intermediate compaction whose output still has older runs beneath it that
       * a tombstone must keep shadowing.
       */
      const mergeCandidatesKeepTombstones = (
        sources: ReadonlyArray<ReadonlyArray<Entry>>,
        desc: boolean,
      ): Entry[] => {
        const best = new Map<string, { e: Entry; pri: number }>()
        for (let pri = 0; pri < sources.length; pri++) {
          for (const e of sources[pri]!) {
            const hex = keyHex(e.key)
            const cur = best.get(hex)
            if (!cur || pri < cur.pri) best.set(hex, { e, pri })
          }
        }
        const all = [...best.values()].map((v) => v.e)
        all.sort((a, b) => (desc ? -compareBytes(a.key, b.key) : compareBytes(a.key, b.key)))
        return all
      }

      /**
       * Order a keyspace's segments newest-first for merge priority: by level
       * ascending (lower level = fresher data) then by segment sequence
       * descending (a later-created run at the same level is fresher). Because a
       * compaction always consumes an entire level, every level's data is
       * strictly older than the level below it, so this order is total and
       * newest-wins-correct.
       */
      const insertByLevel = (existing: ReadonlyArray<SegmentRef>, added: SegmentRef): SegmentRef[] => {
        return [...existing, added].sort((a, b) => a.level - b.level || segSeq(b.id) - segSeq(a.id))
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
                objectPrefix(keyspace),
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
          // Every attempt truncated and we still cannot prove the result is
          // complete. Failing loudly beats silently returning wrong data (the
          // previous fallback dropped all segments AND the range bounds).
          return yield* Effect.fail(
            new StorageError({
              message: `scan(${keyspace}) exhausted retries: range too dense with shadowed/tombstoned entries (last cap ${cap})`,
            }),
          )
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
          const ref = yield* writeSegment(objectPrefix(ks), nextSegId(), 0, entries)
          const prev = ksManifest(ks)
          manifest = {
            ...manifest,
            keyspaces: { ...manifest.keyspaces, [ks]: { segments: [ref, ...prev.segments] } },
          }
          mem.clear()
          yield* maybeCompact(ks)
        })

      /**
       * Size-tiered compaction. Rather than re-merging the *entire* keyspace
       * history on every flush (O(keyspace) memory + O(n²) cumulative write
       * amplification — the previous behaviour), merge only the `compactSegments`
       * runs at the lowest over-full level into one run at the next level. Each
       * compaction therefore touches a bounded number of similarly-sized runs.
       * Tombstones are dropped only when the merge consumes the oldest run and no
       * higher (older) level remains — otherwise a tombstone shadowing data in an
       * un-merged older run must be preserved.
       */
      const maybeCompact = (ks: string): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          const segs = ksManifest(ks).segments
          const byLevel = new Map<number, SegmentRef[]>()
          for (const s of segs) {
            const arr = byLevel.get(s.level) ?? []
            arr.push(s)
            byLevel.set(s.level, arr)
          }
          // Lowest level (freshest) that has accumulated enough runs to compact.
          let level = -1
          for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
            if ((byLevel.get(lvl) ?? []).length >= compactSegments) {
              level = lvl
              break
            }
          }
          if (level < 0) return
          const group = byLevel.get(level)!
          const maxLevel = Math.max(...segs.map((s) => s.level))
          // Safe to drop tombstones only if nothing older than this group exists.
          const dropTombstones = level === maxLevel

          const lists: Entry[][] = []
          for (const seg of group) {
            lists.push(
              yield* scanSegment(objectPrefix(ks), seg, new Uint8Array(), null, false, Infinity, footerCache, blockCache),
            )
          }
          const merged = dropTombstones
            ? mergeCandidates(lists, false, Infinity)
            : mergeCandidatesKeepTombstones(lists, false)
          const ref = yield* writeSegment(objectPrefix(ks), nextSegId(), level + 1, merged)
          // Newest-first ordering: keep runs above the merged group, then the new
          // compacted run, then the older runs below it.
          const groupIds = new Set(group.map((s) => s.id))
          const remaining = segs.filter((s) => !groupIds.has(s.id))
          manifest = {
            ...manifest,
            keyspaces: { ...manifest.keyspaces, [ks]: { segments: insertByLevel(remaining, ref) } },
          }
          for (const seg of group) {
            footerCache.delete(seg.id)
            pendingDeletes.add(`${objectPrefix(ks)}/${seg.id}`)
          }
          // A cascade may now be possible at the next level.
          yield* maybeCompact(ks)
        })

      const gc = (): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          if (pendingDeletes.size === 0) return
          // Remove each key from the pending set only after its delete succeeds,
          // so a mid-loop failure leaves the rest queued for the next gc() rather
          // than orphaning those R2 objects forever.
          for (const key of [...pendingDeletes]) {
            yield* blob.delete(key)
            pendingDeletes.delete(key)
          }
        })

      const encoder = new TextEncoder()
      const mirrorManifest = (): Effect.Effect<void, StorageError, BlobStore> => {
        const key = prefix ? `${prefix}/manifest.json` : "manifest.json"
        return blob.put(key, encoder.encode(JSON.stringify(manifest)))
      }

      const commit = (
        batch: ReadonlyMap<string, ReadonlyArray<Entry>>,
      ): Effect.Effect<number, StorageError, BlobStore> =>
        Effect.gen(function* () {
          let applied = 0
          for (const [ks, entries] of batch) {
            if (entries.length === 0) continue
            const mem = memtableFor(ks)
            for (const e of entries) mem.upsert(e)
            applied += entries.length
          }
          // A no-op commit must not advance the LSN: the watermark drives the
          // conditional (304) query cache, and a spurious bump would invalidate
          // every cached result for nothing.
          if (applied === 0) return manifest.lsn
          manifest = { ...manifest, lsn: manifest.lsn + 1 }
          // A flush failure must not fail the commit: the entries are already
          // applied to the memtable (and are persisted via `dump()`, the DO
          // storage WAL). Failing here would report an applied write as failed
          // — a phantom commit. The flush retries on the next commit.
          yield* Effect.catch(maybeFlush(), (e: StorageError) =>
            Effect.logWarning(`rabbat: memtable flush deferred (will retry): ${e.message}`),
          )
          return manifest.lsn
        })

      const maybeFlush = (): Effect.Effect<void, StorageError, BlobStore> =>
        Effect.gen(function* () {
          for (const [ks, mem] of memtables) {
            // Flush on whichever threshold trips first, so the DO's per-value
            // storage stays bounded regardless of row size.
            if (mem.size >= flushEntries || mem.byteSize >= flushBytes) yield* flushKeyspace(ks)
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
        // States persisted before the seq counter existed restore with a fresh
        // counter (old ids used a different scheme — `seg-<lsn>-<n>` — so they
        // cannot collide with new `seg-<n>` ids).
        manifest = { ...state.manifest, seq: state.manifest.seq ?? 0 }
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
        gc: () => withBlob(gc()),
        mirrorManifest: () => withBlob(mirrorManifest()),
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

/** Parse the monotonic sequence out of a `seg-<n>` id (0 for legacy ids). */
function segSeq(id: string): number {
  const m = /^seg-(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
