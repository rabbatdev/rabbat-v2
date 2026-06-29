import type { Row, Scalar } from "@rabbat/protocol"

/**
 * One stored entry in a keyspace. `key` is the order-preserving encoding of the
 * keyspace's index columns (+ pk tiebreaker). `row === null` is a tombstone
 * (a delete or an index entry vacated by an update), which shadows older
 * segments during a merge.
 */
export interface Entry {
  readonly key: Uint8Array
  readonly pk: Scalar
  readonly row: Row | null
}

/**
 * A keyspace is one sorted index over one table:
 *   `${table}:pk`         — the primary keyspace (key = [pk])
 *   `${table}:${idxName}` — a secondary/composite index (key = [cols…, pk])
 * The full row is denormalised into every keyspace so a range scan reads
 * contiguous blocks and returns whole rows — no secondary point lookups, which
 * would each cost an R2 read.
 */
export const PRIMARY = "pk"

export function keyspaceId(table: string, index: string): string {
  return `${table}:${index}`
}

/** A block within a segment, located by its first key and byte extent. */
export interface BlockRef {
  /** Hex of the block's first key — used to binary-search the sparse index. */
  readonly firstKey: string
  readonly offset: number
  readonly length: number
}

/** The footer of a segment object: its sparse block index + bounds. */
export interface SegmentFooter {
  readonly blocks: ReadonlyArray<BlockRef>
  readonly count: number
  readonly minKey: string
  readonly maxKey: string
}

/** A reference to a segment, recorded in the manifest (metadata, not data). */
export interface SegmentRef {
  readonly id: string
  readonly minKey: string
  readonly maxKey: string
  readonly count: number
  /** Byte offset of the footer within the object (so reads skip a HEAD). */
  readonly footerOffset: number
  readonly footerLength: number
  /** LSM level; level 0 = freshly flushed memtables, higher = compacted. */
  readonly level: number
}

export interface KeyspaceManifest {
  /** Newest segment first; a key present in several segments resolves to the newest. */
  readonly segments: ReadonlyArray<SegmentRef>
}

/**
 * The partition manifest: the segment list per keyspace and the commit
 * watermark. Lives in Durable Object storage (small, bounded) and is mirrored
 * to R2 for disaster recovery.
 */
export interface Manifest {
  readonly lsn: number
  readonly keyspaces: Record<string, KeyspaceManifest>
}

export const emptyManifest = (): Manifest => ({ lsn: 0, keyspaces: {} })
