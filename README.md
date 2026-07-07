# Rabbat v2

**A reactive, horizontally-scalable database that runs entirely on Cloudflare.**
Rabbat v2 is a port of [Rabbat](../rabbat) (Rust + Postgres) to the Cloudflare
stack — **R2** for infinite durable storage, **Durable Objects** for stateful
reactive compute, and **[Effect](https://effect.website) v4** for the runtime —
all in TypeScript. It keeps Rabbat's developer experience (a type-safe functions
API, reactive `useQuery`, bi-directional infinite pagination, SSR preload) while
swapping the engine for primitives that are cheaper to host and scale to zero.

```
┌──────────────┐   call api.messages.list(args)        ┌────────────────────────────┐
│  React app   │ ─────────────────────────────────────▶│  Worker (router / SSR edge) │
│ @rabbat/     │   reactive results / row diffs (WS)    │  • routes by partition key  │
│   react      │◀───────────────────────────────────── │  • query cache (304 / R2)   │
└──────────────┘            ▲                            └──────────────┬──────────────┘
       │ IndexedDB LRU      │ generated api.ts                          │ stub.fetch / WS
       │ cache              │                              ┌────────────▼──────────────┐
       └────────────────────┘        Effect runtime         │  Durable Object (per      │
                                                            │  partition) — COORDINATOR  │
                                                            │  • memtable (recent writes)│
                                                            │  • segment manifest + index│
                                                            │  • RQL · keyset cursors    │
                                                            │  • IVM reactive diffs (WS) │
                                                            └────────────┬──────────────┘
                                            authoritative LSM store: WAL + sorted segments │
                                                                  ┌───────────────▼──────┐
                                                                  │          R2           │
                                                                  │  THE DATABASE (∞)     │
                                                                  └───────────────────────┘
```

**The dataset lives in R2, not in the Durable Object.** R2 holds a
log-structured merge tree — a write-ahead log plus immutable, sorted segments
(SSTable-style: sorted blocks + a sparse block index). That is the authoritative
store and it is bounded only by R2 (effectively infinite). The Durable Object is
a **coordinator and reactive engine** whose durable state is small and bounded: a
*memtable* of recent writes not yet flushed to R2 (flushed at a few MB), the
segment *manifest* (key ranges + sparse indexes — metadata, not rows), and the
IVM index for currently-active subscriptions. A partition can hold terabytes in
R2 while its DO holds megabytes of working metadata, so the DO's ~10 GB storage
limit is **never** the data ceiling. The DO exists because you need exactly one
writer per partition to order commits and run incremental reactivity, and a home
for live WebSocket subscriptions — coordination, with R2 as the substrate.

## Why this maps onto Cloudflare

| Requirement | How Rabbat v2 delivers it |
| --- | --- |
| **Horizontally scalable** | Data is range/hash-partitioned across many Durable Objects, one per partition key. A stateless Worker routes each request to the owning DO. Add partitions → add DOs; there is no central bottleneck. One writer per partition (the DO is single-threaded) preserves commit order, exactly like Rabbat's per-app write lock. |
| **Infinite storage** | The dataset is an **LSM tree in R2**: a write-ahead log plus immutable, sorted segments. The DO holds only a small *memtable* of recent writes (flushed to R2 at a few MB) and the segment *manifest* (metadata). A partition's storage is therefore bounded only by R2 — effectively infinite — and the DO's ~10 GB cap is never the data ceiling. Reads merge the memtable with R2 segments; a range scan resolves to specific R2 blocks via the manifest's sparse index. |
| **Bi-directional infinite scroll / jump-to-item** | Stable keyset cursors over an order-preserving total order. A live window is `{ anchor, before, after }`; `before`/`after` grow independently, and `anchor: { key }` jumps to a row and loads ~one page *around* it (not everything in between). |
| **Incremental reactive engine** | Each subscription's window is maintained by an incremental-view-maintenance index. A write is routed only to subscriptions whose equality-prefix it matches, their windows are reconciled `O(log k)`, and only **diffs** (`upserts` + `removes`) go over the wire — never whole result sets. |
| **SSR preload** | `ctx.preload(api.x, args)` runs the query at the edge, embeds the snapshot **and its commit watermark** in the HTML; the client hydrates from the snapshot and resumes the live subscription from that watermark — no refetch, no flash. |
| **Query caching to cut reads/egress** | Every query response is tagged with the partition's commit LSN. A conditional read (`If-Rabbat-Watermark`) returns `304 Not Modified` when nothing changed, served from the Worker cache without ever waking the DO — cutting R2/DO reads and egress for hot, unchanged queries. |
| **Optional IndexedDB LRU cache** | The client can persist query snapshots in IndexedDB (LRU-capped, namespaced, app-versioned) for instant stale-while-revalidate hydration on reload. |
| **Easy dev with Miniflare** | `rabbat dev` runs the whole stack under `wrangler dev` (Miniflare) with local R2 + DO persistence — no cloud account needed to develop. |

## Monorepo layout (Turborepo + pnpm)

| Package | What it is |
| --- | --- |
| `@rabbat/protocol` | Shared wire protocol (Effect Schema), scalar/row types, order-preserving keys, keyset cursor encode/decode. |
| `@rabbat/schema` | The schema DSL — `defineSchema` / `defineTable` / `s.*` — with full type inference (`DataModelOf`) and DO-SQLite DDL generation. |
| `@rabbat/engine` | The database engine, built on Effect: the R2 LSM store (WAL, memtable, sorted segments, sparse block index, block cache), RQL query spec, keyset cursors, bi-directional windows + jump-to-item, the IVM reactive engine, and query-result caching. |
| `@rabbat/server` | The `RabbatPartition` Durable Object + the routing/SSR Worker, the functions runtime (`query`/`mutation`/`action`, `ctx`, validators, auth/middleware), hibernatable-WebSocket sync, and the conditional query cache. |
| `@rabbat/client` | The reactive client: `FunctionsClient`, the incremental `SubscriptionStore`, the IndexedDB LRU `ValueCache`, and SSR preload seeding. |
| `@rabbat/db` | A flexible, **server-only** DB client for non-reactive queries/mutations *outside* a function context (auth adapters, scripts, crons). Connects to a partition over a service-key-gated admin endpoint; writes stay durable, engine-validated, and reactive. Not for the browser. |
| `@rabbat/react` | React adapter: `useQuery` / `usePaginatedQuery` / `useMutation` / `useAction`, the `RabbatProvider`, and SSR preload/hydration. |
| `@rabbat/router` · `@rabbat/vite-react` | File-based routing: `defineRoute`/`defineLayout`/`defineServerRoute` + the React adapter (`rabbatReact()`) that generates the route manifest, typed `Link`, and client entry. |
| `@rabbat/codegen` | Schema + functions → generated `api.ts` (typed `api`/`internal` trees) and schema JSON. |
| `@rabbat/vite` | The `rabbat()` Vite plugin: auto-discovers `schema.ts` + `functions/`, generates the wired Worker + Durable Object entry + wrangler config + typed `api`, and bundles React + the Cloudflare runtime — so an app is just a schema, functions, and a React UI. |
| `@rabbat/cli` | `rabbat dev` / `build` / `deploy` / `codegen` — drives Vite + wrangler under the hood; the user never touches either directly. |
| `examples/chat` | A reference chat app (**Vite 8 + React**) exercising reactive pagination, jump-to-item, the IndexedDB cache, and the conditional query cache. |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the engine internals.

## Writing an app

The frontend lives in `src/`; the backend lives in `rabbat/`, organized by
concern. You write a schema, functions, and a React UI, and add **one** Vite
plugin — no wrangler config, no Worker entry, no module registry, no imports to
wire up.

```
my-app/
  src/                 # React frontend
    App.tsx
  rabbat/              # backend — discovered by convention
    schema.ts          #   the shared data model
    functions/         #   query / mutation / action files
      messages.ts
    crons/             #   (future) scheduled jobs
    workflows/         #   (future) durable workflows
    _generated/        #   api.ts + worker + wrangler (generated, git-ignored)
  vite.config.ts
```

```ts
// rabbat/schema.ts
export const schema = defineSchema({ messages: defineTable({ /* … */ }) })

// rabbat/functions/messages.ts
export const list = query({ args: { channelId: v.string(), paginationOpts },
  handler: (ctx, a) => ctx.db.table("messages").where("channel_id","=",a.channelId)
    .order("created_at","asc").paginate(a.paginationOpts) })

// vite.config.ts — the only wiring
import { rabbat } from "@rabbat/vite"
export default defineConfig({ plugins: [rabbat()] })
```

```tsx
// src/App.tsx — the generated, fully-typed `api` tree
import { api } from "../rabbat/_generated/api"
const { data, loadOlder } = usePaginatedQuery(api.messages.list, { channelId })
```

`rabbat dev` runs the **whole stack** — React (HMR) + the Worker + the Durable
Object + R2 — in one process on Miniflare. `rabbat()` discovers the `rabbat/`
backend, generates the Worker that wires `definePartition`/`defineWorker`, the
wrangler config, and the typed `api` (all into `rabbat/_generated/`), and bundles
it for Cloudflare. Schema sits at the backend root because every concern —
functions today, crons and workflows next — builds on it.

## Production configuration

The defaults are safe for dev; a multi-tenant production deployment should set:

| Knob | Where | Why |
| --- | --- | --- |
| `compileSchema(schema, { strictIndexes: true })` | worker entry | Reject unindexed (O(table)) queries instead of falling back to a capped scan. |
| `defineWorker({ authenticate, partitionFor })` | worker | Resolve a **verified** identity at the edge and shard on it — never route on unauthenticated client `args` (that lets a tenant target another tenant's partition). |
| `definePartition({ auth, flushBytes, maxMessageBytes })` | partition | Wire real token verification; tune the byte-based flush threshold and inbound message cap. |

Built-in guardrails (always on): per-connection subscription cap, pagination window ceiling (`MAX_WINDOW_SIDE`), per-row/-batch size caps, cursor validation, `internal*` functions are never client-callable, mutations are acked only after they are durable, and a dropped delta drops the connection so the client resyncs.

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @rabbat/engine test      # engine tests (cursors, pagination, IVM, unique, isolation)
pnpm --filter @rabbat/server test      # reactive stack (incremental deltas, routing)
pnpm --filter @rabbat/client test      # client (reconnect, cache, stores)
pnpm --filter chat dev                 # the example app on Miniflare → http://localhost:5173
```
