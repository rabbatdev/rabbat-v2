# @rabbat/db

A flexible, **server-only** database client for Rabbat — for non-reactive
queries and mutations **outside** a rabbat function context. Reach for it when
you're building something that isn't a `query`/`mutation`/`action` handler but
still needs the database: an **auth adapter**, a migration/seed script, a cron
job, or another Worker.

It is *not* the reactive `useQuery` client, and it is **not for the browser** —
it speaks a privileged admin protocol authenticated by a service key.

## Why it exists

Inside a rabbat function you get `ctx.db`, but that only exists within a
function's transaction. An auth library (say, a Better-Auth adapter) runs its
own code and just wants `getUserByEmail` / `createSession` against your data,
with no subscription machinery and no need to predeclare a function per
operation. `@rabbat/db` gives you exactly that — a plain promise-based client —
while every write still goes through the partition's single-writer commit path,
so it stays **durable, ordered, engine-validated** (column kinds, uniqueness,
size caps) and **fans out to live `useQuery` subscribers**.

## Security model

- Every request carries a **service key** in the `X-Rabbat-Service-Key` header.
  The partition compares it in constant time; without it (or if no key is
  configured) the `/db` endpoint returns 403/401.
- Source the key from a secret env var. **Never** ship it — or this package — to
  a browser bundle.
- Prefer the **binding transport** (below): the request never leaves the
  Cloudflare edge, so the key is never sent over the public internet.
- The key is a **full-partition master credential**. There is no per-tenant
  scoping — any holder can target any partition (via the `?partition=` hint on
  the HTTP transport, or `partition` on the binding transport). Keep it in a
  trusted server env only.
- `createRabbatDb` throws if it detects a browser environment, as a backstop
  against accidental bundling.

Enable the endpoint on the partition:

```ts
definePartition({ schema, modules, serviceKey: env.RABBAT_SERVICE_KEY })
```

## Usage

### In a Worker (recommended — `bindingTransport`)

```ts
import { createRabbatDb, bindingTransport } from "@rabbat/db"
import type { DataModel } from "./rabbat/_generated/api"

const db = createRabbatDb<DataModel>(
  bindingTransport({
    namespace: env.RABBAT_PARTITION,      // the DO binding
    serviceKey: env.RABBAT_SERVICE_KEY,
  }),
)

// Reads feel exactly like ctx.db:
const user = await db.table("users").where("email", "=", email).first()

// Writes are plain promises, each an atomic commit:
await db.insert("sessions", { id, userId: user.id, expiresAt })

// Or batch several writes into ONE atomic commit:
await db.tx(async (tx) => {
  tx.patch("users", user.id, { lastSeenAt: Date.now() })
  tx.insert("sessions", { id, userId: user.id, expiresAt })
})
```

### Server-to-server (`httpTransport`)

Enable the admin route on the worker (`defineWorker({ dbAdmin: true })`) and
point the client at it. HTTPS only — the key authenticates the caller.

```ts
import { createRabbatDb, httpTransport } from "@rabbat/db"

const db = createRabbatDb<DataModel>(
  httpTransport({ url: "https://app.example.com/_rabbat/db", serviceKey: KEY }),
)
```

## API

- `db.table(name)` → the same `QueryBuilder` as `ctx.db`: `.where().order()` then
  `.collect() / .take(n) / .first() / .paginate(opts)`.
- `db.get(name, id)` — one row by primary key.
- `db.insert / patch / delete` — single atomic writes.
- `db.tx(async tx => …)` — several writes as one atomic commit (all-or-nothing).
  Reads inside a tx observe committed state, not the tx's own un-flushed writes.
- `db.mutate(writes)` — low-level atomic write batch.

Errors (validation, uniqueness, auth) throw `RabbatDbError`.

## Consistency

Each read/write is its own round trip; a single `tx()`/`mutate()` call is one
atomic commit. There is no cross-call transaction — that is the deliberate
trade for a flexible, function-free client. For read-then-write atomicity within
a single logical unit, do the reads first, then stage the writes in one `tx()`.
