import { Effect, Layer } from "effect"
import {
  type ClientMessage,
  type DbPage,
  type DbRequest,
  type DbWrite,
  type PaginationOpts,
  type ServerMessage,
  SERVICE_KEY_HEADER,
  decodeClientMessage,
} from "@rabbat/protocol"
import type { SchemaInfo } from "@rabbat/schema"
import {
  type DurableState,
  type Mutation,
  Engine,
  EngineLive,
  LsmStoreLive,
  R2BlobStore,
} from "@rabbat/engine"
import { type Identity, COLLECT_LIMIT } from "@rabbat/functions"
import { ReactiveHub, type Outbound } from "./reactive.js"
import { Runtime, type Modules } from "./runtime.js"

export interface PartitionConfig {
  readonly schema: SchemaInfo
  readonly modules: Modules
  readonly auth?: (token: string | null) => Identity | null | Promise<Identity | null>
  /** R2 binding name on the environment (default "RABBAT_BUCKET"). */
  readonly bucketBinding?: string
  /** Flush the memtable to an R2 segment past this many entries. */
  readonly flushEntries?: number
  /** Or past this many bytes (whichever trips first). */
  readonly flushBytes?: number
  /** Max bytes a single inbound WebSocket/HTTP message may carry (default 1 MiB). */
  readonly maxMessageBytes?: number
  /**
   * Enables the privileged `/db` admin endpoint (used by `@rabbat/db`). Requests
   * must present this exact key. Source it from a secret env var; NEVER expose it
   * to the browser. When unset, `/db` is disabled and returns 403.
   */
  readonly serviceKey?: string
}

const DEFAULT_MAX_MESSAGE_BYTES = 1 << 20

/** A live subscription descriptor, persisted per-socket so it survives hibernation. */
interface SubDescriptor {
  readonly sub: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly window?: PaginationOpts
}

/** Per-socket state stored via `serializeAttachment` (survives DO eviction). */
interface SocketAttachment {
  conn: string
  token: string | null
  /**
   * Edge-resolved identity forwarded by the Worker (trusted). `undefined` means
   * the Worker did not do edge auth, so the DO resolves from `token` itself.
   */
  identity?: Identity | null
  subs: SubDescriptor[]
}

/** The header the Worker uses to forward the edge-resolved identity (trusted). */
const INTERNAL_IDENTITY_HEADER = "X-Rabbat-Identity"

/** Read the Worker-forwarded identity; `undefined` = not edge-authenticated. */
function forwardedIdentity(request: Request): Identity | null | undefined {
  const h = request.headers.get(INTERNAL_IDENTITY_HEADER)
  if (h === null) return undefined
  try {
    return JSON.parse(h) as Identity | null
  } catch {
    return undefined
  }
}

/**
 * Build the `RabbatPartition` Durable Object class for an app. One instance owns
 * one partition: it is the single writer (so commits order and mutations are
 * serializable without OCC), runs the reactive engine, and holds live
 * subscriptions. The dataset lives in R2; the DO persists only the small
 * memtable + manifest to its own storage.
 *
 * WebSockets use the Hibernation API (`ctx.acceptWebSocket`), so the DO can
 * evict between messages without dropping connections; per-socket identity and
 * subscription descriptors ride along in the socket attachment and the reactive
 * state is rebuilt lazily on the next message after a cold start.
 */
export function definePartition(config: PartitionConfig): {
  new (ctx: DurableObjectState, env: Record<string, unknown>): DurableObject
} {
  const maxBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES

  return class RabbatPartition implements DurableObject {
    private engine!: Engine["Service"]
    private runtime!: Runtime
    private hub!: ReactiveHub
    private store!: DurableStore
    /** conns whose hub subscriptions have been (re)built this DO lifetime. */
    private readonly warmed = new Set<string>()
    private writeChain: Promise<unknown> = Promise.resolve()
    private readonly ready: Promise<void>

    constructor(
      private readonly ctx: DurableObjectState,
      private readonly env: Record<string, unknown>,
    ) {
      this.ready = this.ctx.blockConcurrencyWhile(() => this.init())
    }

    private async init(): Promise<void> {
      const bucket = this.env[config.bucketBinding ?? "RABBAT_BUCKET"] as R2Bucket
      const layer = EngineLive(config.schema).pipe(
        Layer.provide(
          LsmStoreLive({
            prefix: `app/${this.ctx.id.toString()}`,
            flushEntries: config.flushEntries,
            flushBytes: config.flushBytes,
          }),
        ),
        Layer.provide(R2BlobStore(bucket)),
      )
      this.engine = await Effect.runPromise(Effect.provide(Engine, layer))
      this.store = new DurableStore(this.ctx.storage)
      const saved = await this.store.load()
      if (saved) this.engine.restore(saved)
      this.runtime = new Runtime({ schema: config.schema, modules: config.modules, auth: config.auth }, this.engine)
      this.hub = new ReactiveHub(this.runtime)
      // Server-driven heartbeat so half-open sockets are reclaimed even while the
      // DO is hibernating (auto-responses don't wake the DO).
      try {
        this.ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"))
      } catch {
        /* older runtimes: no auto-response */
      }
    }

    async fetch(request: Request): Promise<Response> {
      await this.ready
      const url = new URL(request.url)
      if (request.headers.get("Upgrade") === "websocket") return this.acceptWs(request, url)
      if (url.pathname.endsWith("/query")) return this.httpQuery(request)
      if (url.pathname.endsWith("/mutate")) return this.httpMutate(request)
      if (url.pathname.endsWith("/call")) return this.httpCall(request)
      if (url.pathname.endsWith("/db")) return this.httpDb(request)
      if (url.pathname.endsWith("/lsn")) return json({ watermark: this.engine.lsn() })
      return new Response("not found", { status: 404 })
    }

    /**
     * The privileged admin/DB endpoint (`@rabbat/db`). Executes raw, un-named
     * table operations directly against the engine — bypassing the function
     * layer's validators/auth by design (a flexible client for code running
     * outside a rabbat function). Gated by a constant-time service-key check;
     * writes still run through the single-writer commit path (durable +
     * reactive fan-out) and the engine's own validation (kinds, unique, caps).
     */
    private async httpDb(request: Request): Promise<Response> {
      if (!config.serviceKey) {
        return json({ ok: false, error: "admin DB endpoint disabled (no serviceKey configured)" }, {}, 403)
      }
      const presented = request.headers.get(SERVICE_KEY_HEADER)
      if (!presented || !(await safeKeyEqual(presented, config.serviceKey))) {
        return json({ ok: false, error: "unauthorized" }, {}, 401)
      }
      let req: DbRequest
      try {
        req = (await readJson(request, maxBytes)) as DbRequest
      } catch (e) {
        return json({ ok: false, error: clientError(e) }, {}, 400)
      }
      try {
        switch (req.op) {
          case "get": {
            const value = await Effect.runPromise(this.engine.get(req.table, req.pk))
            return json({ ok: true, value })
          }
          case "query": {
            const limit = clampLimit(req.limit)
            const value = await Effect.runPromise(this.engine.collect(req.spec, limit))
            return json({ ok: true, value })
          }
          case "paginate": {
            const out = await Effect.runPromise(this.engine.paginate(req.spec, req.opts))
            const value: DbPage = {
              rows: out.rows,
              pk: out.pk,
              order: out.order,
              hasOlder: out.hasOlder,
              hasNewer: out.hasNewer,
              total: out.total,
            }
            return json({ ok: true, value })
          }
          case "mutate": {
            if (!Array.isArray(req.writes)) return json({ ok: false, error: "writes must be an array" }, {}, 400)
            const mutations = req.writes.map(toEngineMutation)
            const result = await this.serialize(() => Effect.runPromise(this.engine.mutate(mutations)))
            // Same durability + reactivity as a function mutation: persist before
            // returning, then fan out deltas so live subscriptions update.
            await this.afterCommit(result.changes, [])
            return json({ ok: true, value: { lsn: result.lsn, changes: result.changes.length } })
          }
          default:
            return json({ ok: false, error: "unknown op" }, {}, 400)
        }
      } catch (e) {
        return json({ ok: false, error: clientError(e) }, {}, 400)
      }
    }

    /**
     * Generic dispatch used by edge API routes (`defineServerRoute`'s
     * `ctx.runQuery`/`runMutation`/`runAction`). Runs the named function with the
     * caller's identity; a mutation is committed durably (persist-before-return)
     * and its deltas fan out, exactly like the WS/HTTP mutation paths.
     */
    private async httpCall(request: Request): Promise<Response> {
      let body: { kind?: unknown; name?: unknown; args?: unknown; token?: unknown }
      try {
        body = (await readJson(request, maxBytes)) as typeof body
      } catch (e) {
        return json({ error: clientError(e) }, {}, 400)
      }
      if (typeof body.name !== "string" || (body.kind !== "query" && body.kind !== "mutation" && body.kind !== "action")) {
        return json({ error: "invalid call" }, {}, 400)
      }
      const fwd = forwardedIdentity(request)
      const identity = fwd !== undefined ? fwd : await this.identityFor(typeof body.token === "string" ? body.token : null)
      const args = (body.args as Record<string, unknown>) ?? {}
      try {
        if (body.kind === "query") {
          const r = await this.runtime.runQuery(body.name, args, identity)
          return json({ value: r.paginated ? r.captured?.page : r.value })
        }
        if (body.kind === "action") {
          return json({ value: await this.runtime.runAction(body.name, args, identity) })
        }
        const result = await this.serialize(() => this.runtime.runMutation(body.name as string, args, identity))
        await this.afterCommit(result.changes, result.scheduled)
        return json({ value: result.value })
      } catch (e) {
        return json({ error: clientError(e) }, {}, 400)
      }
    }

    // ── WebSocket sync (Hibernation API) ──────────────────────────────────────

    private acceptWs(request: Request, url: URL): Response {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      const conn = crypto.randomUUID()
      const token = url.searchParams.get("token")
      // Trust the Worker's edge-resolved identity when present (it authenticated
      // where DB bindings work); otherwise the DO resolves from the token.
      const attachment: SocketAttachment = { conn, token, identity: forwardedIdentity(request), subs: [] }
      // Hibernatable accept: the runtime persists the socket across eviction.
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment(attachment)
      this.warmed.add(conn) // fresh socket: nothing to rehydrate
      return new Response(null, { status: 101, webSocket: client })
    }

    async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
      await this.ready
      const raw = typeof data === "string" ? data : new TextDecoder().decode(data)
      if (raw.length > maxBytes) {
        send(ws, { type: "error", message: "message too large" })
        return
      }
      const att = (ws.deserializeAttachment() as SocketAttachment | null) ?? { conn: crypto.randomUUID(), token: null, subs: [] }
      // After a cold start the hub is empty; rebuild this socket's subscriptions
      // from its persisted descriptors before handling the new message.
      await this.rewarm(ws, att)

      let msg: ClientMessage
      try {
        msg = decodeClientMessage(JSON.parse(raw))
      } catch (e) {
        send(ws, { type: "error", message: `bad message: ${String(e)}` })
        return
      }
      // Prefer the Worker's edge-resolved identity (trusted); otherwise resolve
      // synchronously from the socket's token. Either way it's ready before any
      // message runs — no fire-and-forget race, no anonymous window.
      const identity = att.identity !== undefined ? att.identity : await this.identityFor(att.token)
      try {
        switch (msg.type) {
          case "setAuth": {
            att.token = msg.token
            ws.serializeAttachment(att)
            // With edge auth, identity is fixed at connect (the client reconnects
            // to change it), so keep it; otherwise re-resolve from the new token.
            const id = att.identity !== undefined ? att.identity : await this.identityFor(msg.token)
            return this.dispatch(await this.hub.reauth(att.conn, id))
          }
          case "subscribe": {
            const out = await this.hub.subscribe(att.conn, msg.sub, msg.name, msg.args, msg.pagination, identity, msg.watermark)
            upsertDescriptor(att, { sub: msg.sub, name: msg.name, args: msg.args, window: msg.pagination })
            ws.serializeAttachment(att)
            return this.dispatch(out)
          }
          case "setPagination": {
            const out = await this.hub.setPagination(att.conn, msg.sub, msg.pagination as PaginationOpts)
            const d = att.subs.find((s) => s.sub === msg.sub)
            if (d) {
              att.subs = att.subs.map((s) => (s.sub === msg.sub ? { ...s, window: msg.pagination as PaginationOpts } : s))
              ws.serializeAttachment(att)
            }
            return this.dispatch(out)
          }
          case "unsubscribe": {
            this.hub.unsubscribe(att.conn, msg.sub)
            att.subs = att.subs.filter((s) => s.sub !== msg.sub)
            ws.serializeAttachment(att)
            return
          }
          case "mutation": {
            const result = await this.serialize(() => this.runtime.runMutation(msg.name, msg.args, identity))
            // Durable BEFORE the client is told the write succeeded.
            await this.afterCommit(result.changes, result.scheduled)
            send(ws, { type: "mutationResult", id: msg.id, value: result.value })
            return
          }
          case "action": {
            const value = await this.runtime.runAction(msg.name, msg.args, identity)
            send(ws, { type: "actionResult", id: msg.id, value })
            return
          }
          case "ping": {
            send(ws, { type: "pong", id: msg.id })
            return
          }
        }
      } catch (e) {
        const id = "id" in msg ? msg.id : undefined
        const sub = "sub" in msg ? msg.sub : undefined
        send(ws, { type: "error", id, sub, message: clientError(e) })
      }
    }

    webSocketClose(ws: WebSocket): void {
      const att = ws.deserializeAttachment() as SocketAttachment | null
      if (att) {
        this.hub.removeConnection(att.conn)
        this.warmed.delete(att.conn)
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }

    webSocketError(ws: WebSocket): void {
      this.webSocketClose(ws)
    }

    /** Rebuild a socket's hub subscriptions after a cold start (hibernation wake). */
    private async rewarm(ws: WebSocket, att: SocketAttachment): Promise<void> {
      if (this.warmed.has(att.conn)) return
      this.warmed.add(att.conn)
      if (att.subs.length === 0) return
      const identity = await this.identityFor(att.token)
      for (const d of att.subs) {
        try {
          const out = await this.hub.subscribe(att.conn, d.sub, d.name, d.args, d.window, identity)
          this.dispatch(out, ws)
        } catch {
          /* a now-invalid subscription is simply dropped on rewarm */
        }
      }
    }

    // Short-lived identity cache: dedupes bursts of messages on one token without
    // pinning a revoked/expired token to its old identity for the DO's lifetime,
    // and bounded in size so distinct tokens can't grow it without limit.
    private static readonly IDENTITY_TTL_MS = 10_000
    private static readonly IDENTITY_CACHE_MAX = 1024
    private identityCache = new Map<string | null, { at: number; p: Promise<Identity | null> }>()
    private identityFor(token: string | null): Promise<Identity | null> {
      const now = Date.now()
      const hit = this.identityCache.get(token)
      if (hit && now - hit.at < RabbatPartition.IDENTITY_TTL_MS) return hit.p
      const p = this.runtime.resolveIdentity(token).catch(() => null)
      this.identityCache.set(token, { at: now, p })
      if (this.identityCache.size > RabbatPartition.IDENTITY_CACHE_MAX) {
        // Evict the oldest-inserted entry (Map preserves insertion order).
        const oldest = this.identityCache.keys().next().value
        if (oldest !== undefined) this.identityCache.delete(oldest)
      }
      return p
    }

    // ── HTTP (SSR preload + conditional cache) ────────────────────────────────

    private async httpQuery(request: Request): Promise<Response> {
      let body: { name?: unknown; args?: unknown; pagination?: unknown; token?: unknown }
      try {
        body = (await readJson(request, maxBytes)) as typeof body
      } catch (e) {
        return json({ error: clientError(e) }, {}, 400)
      }
      if (typeof body.name !== "string") return json({ error: "missing function name" }, {}, 400)
      const ifWatermark = request.headers.get("If-Rabbat-Watermark")
      const current = this.engine.lsn()
      // Resolve identity FIRST: a 304 must not hand back another (or a revoked)
      // identity's cached body, so we authenticate before the watermark shortcut.
      const fwd = forwardedIdentity(request)
      const identity = fwd !== undefined ? fwd : await this.identityFor(typeof body.token === "string" ? body.token : null)
      if (ifWatermark !== null && Number.isFinite(Number(ifWatermark)) && Number(ifWatermark) === current) {
        return new Response(null, { status: 304, headers: { "Rabbat-Watermark": String(current) } })
      }
      const pagination = body.pagination as PaginationOpts | undefined
      const args = pagination
        ? { ...((body.args as Record<string, unknown>) ?? {}), paginationOpts: pagination }
        : ((body.args as Record<string, unknown>) ?? {})
      let result
      try {
        result = await this.runtime.runQuery(body.name, args, identity)
      } catch (e) {
        return json({ error: clientError(e) }, { "Rabbat-Watermark": String(current) }, 400)
      }
      const payload = result.paginated && result.captured
        ? {
            paginated: true,
            page: result.captured.page.page,
            pk: result.captured.pk,
            order: result.captured.order,
            hasOlder: result.captured.page.hasOlder,
            hasNewer: result.captured.page.hasNewer,
            total: result.captured.page.total,
            watermark: current,
          }
        : { paginated: false, value: result.value, watermark: current }
      return json(payload, {
        "Rabbat-Watermark": String(current),
        "Cache-Control": "private, max-age=0, must-revalidate",
      })
    }

    private async httpMutate(request: Request): Promise<Response> {
      let body: { name?: unknown; args?: unknown; token?: unknown }
      try {
        body = (await readJson(request, maxBytes)) as typeof body
      } catch (e) {
        return json({ error: clientError(e) }, {}, 400)
      }
      if (typeof body.name !== "string") return json({ error: "missing function name" }, {}, 400)
      const fwd = forwardedIdentity(request)
      const identity = fwd !== undefined ? fwd : await this.identityFor(typeof body.token === "string" ? body.token : null)
      try {
        const result = await this.serialize(() =>
          this.runtime.runMutation(body.name as string, (body.args as Record<string, unknown>) ?? {}, identity),
        )
        await this.afterCommit(result.changes, result.scheduled)
        return json({ value: result.value, watermark: result.lsn })
      } catch (e) {
        return json({ error: clientError(e) }, {}, 400)
      }
    }

    // ── Commit fan-out + durability ───────────────────────────────────────────

    private async afterCommit(
      changes: ReadonlyArray<import("@rabbat/engine").RowChange>,
      scheduled: ReadonlyArray<import("./runtime.js").ScheduledCall>,
    ): Promise<void> {
      // Persist scheduled jobs together with engine state, then fan out. Durable
      // before any client observes the commit or its scheduled side effects.
      await this.store.persist(this.engine.dump(), scheduled)
      // The manifest is now durable, so compaction-superseded R2 objects can be
      // safely deleted (a crash before this only leaves reclaimable orphans).
      await Effect.runPromise(this.engine.gc()).catch(() => {})
      // Mirror the (tiny) manifest to R2 for disaster recovery. Best-effort.
      await Effect.runPromise(this.engine.mirrorManifest()).catch(() => {})
      if (scheduled.length > 0) await this.rescheduleAlarm()
      const out = await this.hub.onCommit(changes)
      this.dispatch(out)
    }

    async alarm(): Promise<void> {
      await this.ready
      const now = Date.now()
      const due = await this.store.dueJobs(now)
      for (const job of due) {
        try {
          const result = await this.serialize(() => this.runtime.runScheduled(job.name, job.args))
          await this.afterCommit(result.changes, result.scheduled)
          await this.store.completeJob(job.id)
        } catch (e) {
          // Bounded retry with backoff; give up (dead-letter) past the cap so a
          // permanently-failing job can't wedge the alarm queue.
          const attempts = job.attempts + 1
          if (attempts >= 5) {
            await this.store.completeJob(job.id)
            console.error(`rabbat: scheduled job ${job.name} failed permanently: ${clientError(e)}`)
          } else {
            await this.store.retryJob(job.id, attempts, now + backoffMs(attempts))
          }
        }
      }
      await this.rescheduleAlarm()
    }

    /** Set the alarm to the earliest outstanding job (never overwriting it later). */
    private async rescheduleAlarm(): Promise<void> {
      const next = await this.store.earliestJobAt()
      if (next === null) return
      const existing = await this.ctx.storage.getAlarm()
      if (existing === null || next < existing) await this.ctx.storage.setAlarm(next)
    }

    private dispatch(out: Outbound[], only?: WebSocket): void {
      if (out.length === 0) return
      // Map connection ids to their live sockets.
      const byConn = new Map<string, WebSocket>()
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null
        if (att) byConn.set(att.conn, ws)
      }
      for (const o of out) {
        const ws = only && sameConn(only, o.conn) ? only : byConn.get(o.conn)
        if (!ws) continue
        // A send failure means the socket is gone/backpressured; drop the
        // connection so the client reconnects and resyncs rather than silently
        // diverging (the IVM would otherwise assume the dropped delta arrived).
        if (!send(ws, o.message)) {
          this.hub.removeConnection(o.conn)
          this.warmed.delete(o.conn)
          try {
            ws.close(1011, "send failed")
          } catch {
            /* already closed */
          }
        }
      }
    }

    /** Serialize mutations so commits order and stay serializable per partition. */
    private serialize<T>(fn: () => Promise<T>): Promise<T> {
      const next = this.writeChain.then(fn, fn)
      this.writeChain = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }
  }
}

function sameConn(ws: WebSocket, conn: string): boolean {
  const att = ws.deserializeAttachment() as SocketAttachment | null
  return att?.conn === conn
}

function upsertDescriptor(att: SocketAttachment, d: SubDescriptor): void {
  const i = att.subs.findIndex((s) => s.sub === d.sub)
  if (i >= 0) att.subs[i] = d
  else att.subs.push(d)
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 60_000)
}

/**
 * Max rows a single admin `query` may pull. `QueryBuilder.collect()` deliberately
 * over-fetches by one (COLLECT_LIMIT + 1) so that hitting the cap raises a loud
 * error instead of silently truncating — so the admin cap must allow that
 * sentinel row through, i.e. COLLECT_LIMIT + 1, or the guard never fires.
 */
const DB_QUERY_LIMIT = COLLECT_LIMIT + 1
function clampLimit(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return DB_QUERY_LIMIT
  return Math.min(n, DB_QUERY_LIMIT)
}

/** Map an admin wire-write to an engine mutation (engine re-validates values). */
function toEngineMutation(w: DbWrite): Mutation {
  switch (w.kind) {
    case "insert":
      return { kind: "insert", table: w.table, row: w.row }
    case "patch":
      return { kind: "patch", table: w.table, pk: w.pk, fields: w.fields }
    case "delete":
      return { kind: "delete", table: w.table, pk: w.pk }
    default:
      // Untrusted input: reject an unknown write kind with a clear message
      // rather than mapping to `undefined` and surfacing a masked internal error.
      throw new Error(`unknown write kind: ${JSON.stringify((w as { kind?: unknown }).kind)}`)
  }
}

/**
 * Constant-time service-key comparison. Both sides are SHA-256'd first so the
 * compare is over fixed-length digests (no length leak) and takes the same time
 * regardless of where the first mismatching byte is.
 */
async function safeKeyEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ])
  const x = new Uint8Array(da)
  const y = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

function chunkCount(len: number, chunk: number): number {
  return len === 0 ? 0 : Math.ceil(len / chunk)
}

/** A fast, stable 32-bit content hash (FNV-1a) for change detection. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

interface ScheduledJobRecord {
  id: string
  at: number
  name: string
  args: Record<string, unknown>
  attempts: number
}

/**
 * The Durable-Object-storage persistence layer. State is split so no single
 * value approaches the per-value size limit and only keyspaces touched by a
 * commit are rewritten (bounded write amplification):
 *   `rabbat:manifest`         — the segment manifest + LSN (small)
 *   `rabbat:mem-index`        — { [keyspace]: chunkCount }
 *   `rabbat:mem:<ks>:<i>`     — a ≤64 KiB slice of the keyspace memtable JSON
 *   `rabbat:job:<id>`         — one scheduled job
 */
class DurableStore {
  private static readonly CHUNK = 64 * 1024
  private static readonly MANIFEST = "rabbat:manifest"
  private static readonly MEM_INDEX = "rabbat:mem-index"
  /** Content signature per keyspace, so unchanged memtables are never rewritten. */
  private readonly sigs = new Map<string, string>()

  constructor(private readonly storage: DurableObjectStorage) {}

  async load(): Promise<DurableState | undefined> {
    const manifest = await this.storage.get<DurableState["manifest"]>(DurableStore.MANIFEST)
    if (!manifest) return undefined
    const index = (await this.storage.get<Record<string, number>>(DurableStore.MEM_INDEX)) ?? {}
    const memtables: Record<string, ReadonlyArray<unknown>> = {}
    for (const [ks, chunks] of Object.entries(index)) {
      let s = ""
      for (let i = 0; i < chunks; i++) {
        s += (await this.storage.get<string>(`rabbat:mem:${ks}:${i}`)) ?? ""
      }
      if (s.length > 0) memtables[ks] = JSON.parse(s)
    }
    return { manifest, memtables } as DurableState
  }

  /** Persist the manifest, any changed keyspace memtables, and scheduled jobs. */
  async persist(
    state: DurableState,
    scheduled: ReadonlyArray<import("./runtime.js").ScheduledCall>,
  ): Promise<void> {
    const puts: Record<string, unknown> = { [DurableStore.MANIFEST]: state.manifest }
    const deletes: string[] = []
    const index = (await this.storage.get<Record<string, number>>(DurableStore.MEM_INDEX)) ?? {}

    // Reconcile every keyspace the engine currently holds plus any previously
    // persisted (so an emptied one is cleaned up), but only actually write the
    // ones whose content signature changed — bounding write amplification to
    // touched keyspaces regardless of how many tables the partition has.
    const dumped = state.memtables as Record<string, ReadonlyArray<unknown>>
    const keyspaces = new Set<string>([...Object.keys(dumped), ...Object.keys(index)])
    // Staged signature updates: only committed to `this.sigs` AFTER the write
    // durably lands. Committing early would let a later commit skip a keyspace
    // whose write actually failed here, silently losing its data.
    const pendingSigs: Array<[string, string]> = []
    let indexChanged = false
    for (const ks of keyspaces) {
      const entries = dumped[ks] ?? []
      const json = entries.length > 0 ? JSON.stringify(entries) : ""
      const sig = `${json.length}:${fnv1a(json)}`
      if (this.sigs.get(ks) === sig && (index[ks] ?? 0) === chunkCount(json.length, DurableStore.CHUNK)) {
        continue // unchanged since last persist — skip
      }
      const newChunks = chunkCount(json.length, DurableStore.CHUNK)
      const oldChunks = index[ks] ?? 0
      for (let i = 0; i < newChunks; i++) {
        puts[`rabbat:mem:${ks}:${i}`] = json.slice(i * DurableStore.CHUNK, (i + 1) * DurableStore.CHUNK)
      }
      for (let i = newChunks; i < oldChunks; i++) deletes.push(`rabbat:mem:${ks}:${i}`)
      if (newChunks === 0) delete index[ks]
      else index[ks] = newChunks
      pendingSigs.push([ks, sig])
      indexChanged = true
    }
    if (indexChanged) puts[DurableStore.MEM_INDEX] = index

    for (const s of scheduled) {
      const id = crypto.randomUUID()
      const rec: ScheduledJobRecord = { id, at: s.at, name: s.name, args: s.args, attempts: 0 }
      puts[`rabbat:job:${id}`] = rec
    }

    // One atomic-ish batch: DO storage.put coalesces these into the same write.
    await this.storage.put(puts)
    if (deletes.length > 0) await this.storage.delete(deletes)
    // The write is durable — now it is safe to record the signatures.
    for (const [ks, sig] of pendingSigs) this.sigs.set(ks, sig)
  }

  async dueJobs(now: number): Promise<ScheduledJobRecord[]> {
    const map = await this.storage.list<ScheduledJobRecord>({ prefix: "rabbat:job:" })
    return [...map.values()].filter((j) => j.at <= now).sort((a, b) => a.at - b.at)
  }

  async earliestJobAt(): Promise<number | null> {
    const map = await this.storage.list<ScheduledJobRecord>({ prefix: "rabbat:job:" })
    let min: number | null = null
    for (const j of map.values()) if (min === null || j.at < min) min = j.at
    return min
  }

  async completeJob(id: string): Promise<void> {
    await this.storage.delete(`rabbat:job:${id}`)
  }

  async retryJob(id: string, attempts: number, at: number): Promise<void> {
    const rec = await this.storage.get<ScheduledJobRecord>(`rabbat:job:${id}`)
    if (rec) await this.storage.put(`rabbat:job:${id}`, { ...rec, attempts, at })
  }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text()
  if (text.length > maxBytes) throw new Error("request body too large")
  return JSON.parse(text)
}

function send(ws: WebSocket, message: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

function json(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

/** A safe, client-facing error message (never leaks engine/R2 internals). */
function clientError(e: unknown): string {
  const name = e instanceof Error ? e.name : ""
  const msg = e instanceof Error ? e.message : String(e)
  // Surface validation/query/uniqueness errors; mask everything else.
  if (["ValidationError", "QueryError", "UniqueViolation", "CursorError"].includes(name)) return msg
  if (/^(unknown function|Authentication required|not a (query|mutation|action)|subscription limit|message too large|missing function name|request body too large|unknown write kind|writes must be an array|unknown op)/.test(msg)) {
    return msg
  }
  return "internal error"
}
