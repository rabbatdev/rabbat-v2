# Rabbat v2 — architecture

This document explains how the engine works. The headline: **R2 is the database**
(an LSM tree), the **Durable Object is a single-writer coordinator and reactive
engine**, and a **Worker** routes and caches. Everything is TypeScript on Effect v4.

## Storage: a log-structured merge tree on R2

A partition's data lives in R2 as immutable, sorted **segments** plus a small
in-memory **memtable** of recent writes (held by the DO). This is a classic LSM
tree, with R2 as the durable substrate.

- **Order-preserving keys** (`engine/src/keys.ts`). Every index key is a tuple of
  column values encoded to bytes such that `memcmp(encode(a), encode(b))` equals
  the logical order of `a` and `b` (sign-flipped ints/floats via the IEEE-754
  transform; length-terminated, escaped text). So a byte-range scan over encoded
  keys visits rows in logical order — a keyset range read with no sort step.
- **Keyspaces.** Each table has one keyspace per index: `table:pk` (the primary
  keyspace, key = `[pk]`) and `table:<index>` (key = `[cols…, pk]`). The full row
  is denormalized into every keyspace, so a range scan reads contiguous blocks and
  returns whole rows — no secondary point lookups, each of which would be an R2 read.
- **Segments** (`engine/src/lsm/segment.ts`). A segment is a sorted run written to
  one R2 object: a sequence of fixed-size **blocks** followed by a **footer** with a
  sparse index (each block's first key + byte extent) and bounds. A scan binary-
  searches the footer and issues **R2 range GETs** for only the blocks the window
  touches — bytes fetched are proportional to the window, not the segment. Decoded
  blocks and footers are held in an in-memory LRU to cut egress further.
- **Memtable** (`engine/src/lsm/memtable.ts`). Recent writes for a keyspace, kept
  sorted (binary insertion) with a hash map for overwrite. Flushed to a new R2
  segment once it passes a threshold (a few MB), so it never grows toward the DO
  storage limit. **This is the only data the DO holds.**
- **Merge + compaction** (`engine/src/lsm/store.ts`). A scan merges the memtable
  with the overlapping segments, newest-source-wins per key, dropping tombstones.
  Level-0 segments compact into one sorted run past a threshold; superseded R2
  objects are deleted.
- **Manifest.** The list of segments per keyspace + the commit LSN. Small metadata,
  persisted to DO storage (and recoverable), never the dataset.

The DO persists `engine.dump()` (manifest + un-flushed memtable) to its own storage
after every commit — a durable WAL that is continuously drained to R2.

## Queries: RQL, index seeks, cursors

`ctx.db.table(t).where(...).order(...)` compiles to a structured `QuerySpec`
(`protocol/src/query.ts`). The planner (`engine/src/query.ts`) picks an index whose
leading columns are equality-pinned and whose trailing columns are exactly the
effective order — that query is served by an **index seek** (`O(log n + page)`,
no scan + sort). The primary key is appended to the order so it is total, which is
what makes cursors stable. Unindexed queries fall back to a filtered full scan + sort
(fine for dev/small tables); compiling the schema with `{ strictIndexes: true }` rejects
them outright, and even in permissive mode a fallback scan that hits its cap fails loudly
rather than silently truncating.

## Pagination: bi-directional windows + jump-to-item

A live window is `{ anchor, before, after }` (`engine/src/paginate.ts`):

- `before` rows before the anchor and `after` rows at/after it, each grown
  independently — infinite scroll in **both** directions.
- The anchor is `latest` (live tail), `earliest` (a feed), `cursor` (a keyset
  position), or `key` (**jump to a specific row by primary key**). A jump resolves
  the row, computes its cursor in the query's order, and loads ~one page *around* it
  by seeking — it does **not** read everything in between.

Cursors are opaque base64 of the sort-key tuple, stable across concurrent
inserts/deletes (`protocol/src/cursor.ts`).

## Reactivity: incremental view maintenance + routing

The reactive engine streams **diffs**, never whole result sets.

- **Routing.** Each subscription has equality bindings from its filter (e.g.
  `channel_id = X`). A committed write is delivered only to subscriptions whose
  bindings it matches — a write to channel A never examines channel B's
  subscriptions (`server/src/reactive.ts`).
- **Quick-reject + IVM** (`engine/src/ivm.ts`). A `Subscription` holds the rows last
  sent. `windowCanChange()` skips re-evaluating a window when a change provably
  lands outside its loaded edges (with more rows already known on that side).
  Otherwise the window is re-materialized (a bounded, cache-hot read) and diffed
  against what the client last saw into `upserts` (changed/new rows) + `removes`
  (departed primary keys).
- **Value queries.** Non-paginated queries (e.g. `collect()`) re-run only when a
  change matches a dependency they read, and re-send only if the value differs.
- **Single writer.** The DO serializes mutations through one chain, so commits order
  and a per-partition mutation is serializable **without OCC** — rows never span
  partitions, so there are no cross-partition write conflicts.

## The runtime, the Durable Object, and the Worker

- **Runtime** (`server/src/runtime.ts`) bridges Promise-based handlers to the
  Effect engine: it validates args, runs a query while capturing its reactive
  dependencies / paginated window, runs a mutation by buffering its writes into one
  atomic `engine.mutate` commit, and runs an action with `runQuery`/`runMutation`.
- **`RabbatPartition` Durable Object** (`server/src/partition.ts`) builds the engine
  over the R2 binding, restores its memtable+manifest from DO storage, accepts
  WebSockets, serializes mutations, fans out deltas on commit, and persists after
  each write. Scheduled jobs use DO alarms.
- **Worker** (`server/src/worker.ts`) routes WebSocket upgrades and function calls to
  the owning partition (shard with `partitionFor`), and fronts one-shot queries with
  a **conditional cache**: it revalidates against the DO with the cached commit
  watermark, and on `304 Not Modified` serves the cached body without the DO reading
  R2 — cutting reads/egress for hot, unchanged queries.

## Client, caching, SSR

- **`@rabbat/client`** multiplexes every live query over one WebSocket; identical
  acquisitions share one store and one server subscription (refcounted). A paginated
  store keeps its window sorted and splices each delta in by binary search.
- **IndexedDB LRU** (`client/src/cache.ts`, optional) persists query snapshots for
  instant stale-while-revalidate hydration; no-ops where IndexedDB is absent.
- **SSR preload** (`react/src/ssr.ts`): run a query at the edge, embed the snapshot
  + its watermark, hydrate the client from it, and the live subscription resumes
  from that watermark — no refetch, no flash.

## Effect v4

Services (`Context.Service`), layers (`Layer.effect`/`Layer.succeed`), typed errors
(`Data.TaggedError`), and `Effect.gen` thread through the engine. `BlobStore` is a
service with an R2 implementation (production) and an in-memory one (tests), so the
whole engine is unit-testable in Node and runs unchanged on workerd.
