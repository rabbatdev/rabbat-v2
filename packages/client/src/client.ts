import type { ClientMessage, PaginationOpts, Row, ServerMessage } from "@rabbat/protocol"
import { ValueCache, type ValueCacheOptions } from "./cache.js"
import { SubscriptionStore, ValueStore } from "./store.js"

export type ConnectionStatus = "connecting" | "open" | "closed"

/**
 * Stable JSON: object keys are emitted in sorted order at every depth, so
 * structurally-equal args produce byte-identical strings ({a,b} === {b,a}).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  }
  return `{${parts.join(",")}}`
}

/** The cache/preload key for a (function, args) pair (order-insensitive in args). */
export function preloadKey(name: string, args: unknown): string {
  return `${JSON.stringify(name)},${stableStringify(args)}`
}

/** The serialized snapshot the SSR layer embeds and the cache stores. */
export type Preload =
  | {
      paginated: true
      page: ReadonlyArray<Row>
      pk: string
      order: ReadonlyArray<{ column: string; desc: boolean }>
      hasOlder: boolean
      hasNewer: boolean
      total: number
      watermark: number
    }
  | { paginated: false; value: unknown; watermark: number }

export interface FunctionsClientOptions {
  readonly url: string
  readonly token?: string | null
  readonly reconnect?: boolean
  readonly reconnectBaseMs?: number
  readonly persist?: boolean | ValueCacheOptions
  readonly preloaded?: Record<string, Preload>
  /** Reject an in-flight mutation/action after this long (default 30s; 0 disables). */
  readonly requestTimeoutMs?: number
  /** Cap on mutations/actions buffered while offline (default 100). */
  readonly maxOutbox?: number
}

interface SubRecord {
  readonly key: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly subId: string
  kind: "paginated" | "value"
  store: SubscriptionStore | ValueStore
  window?: PaginationOpts
  refcount: number
  subscribed: boolean
  firstDelta: boolean
  /** Pending deferred teardown timer (set while refcount is 0 in the grace window). */
  teardown?: ReturnType<typeof setTimeout>
  /** Sweep timer for a record created during render but never retained (leak guard). */
  sweep?: ReturnType<typeof setTimeout>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

/** How long a subscription lingers at refcount 0 before teardown (survives StrictMode). */
const RELEASE_GRACE_MS = 300

/** Default cap on mutations/actions buffered while offline. */
const DEFAULT_MAX_OUTBOX = 100

/** Client-lifecycle message types are rebuilt on reconnect, never buffered. */
function isLifecycle(type: ClientMessage["type"]): boolean {
  return type === "subscribe" || type === "unsubscribe" || type === "setPagination" || type === "setAuth"
}

/**
 * The browser-side reactive client: one WebSocket multiplexes every live query.
 * Components acquire a subscription by (function, args); identical acquisitions
 * share one store and one server subscription (refcounted). Incoming diffs are
 * applied to the matching store. Mutations/actions are request/response over the
 * same socket. SSR preloads and the optional IndexedDB cache seed stores so the
 * first render has data and then goes live with no flash.
 */
export class FunctionsClient {
  private ws: WebSocket | null = null
  private status: ConnectionStatus = "closed"
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>()
  private readonly subs = new Map<string, SubRecord>()
  private readonly bySubId = new Map<string, SubRecord>()
  private subCounter = 0
  private reqCounter = 0
  private readonly pending = new Map<number, Pending>()
  private outbox: ClientMessage[] = []
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  /** Set by close(); suppresses reconnection regardless of the reconnect option. */
  private closed = false
  private token: string | null
  private readonly cache?: ValueCache

  /** SSR/loader-seeded snapshots, keyed by `preloadKey(name, args)`. */
  private readonly preloads = new Map<string, Preload>()

  constructor(private readonly options: FunctionsClientOptions) {
    this.token = options.token ?? null
    if (options.persist) {
      this.cache = new ValueCache(typeof options.persist === "object" ? options.persist : {})
    }
    for (const [key, pre] of Object.entries(options.preloaded ?? {})) this.preloads.set(key, pre)
  }

  /**
   * Seed a query snapshot at runtime (a route loader ran and fetched it), so a
   * subscription acquired next renders from it with no flash. Applies to any
   * already-acquired matching store that hasn't gone live yet.
   */
  seedPreload(name: string, args: Record<string, unknown>, pre: Preload): void {
    const key = preloadKey(name, args)
    this.preloads.set(key, pre)
    for (const rec of this.subs.values()) {
      if (preloadKey(rec.name, rec.args) === key && !rec.store.ready()) this.applyPreload(rec, pre)
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws || typeof WebSocket === "undefined") return
    this.closed = false
    this.status = "connecting"
    this.emitStatus()
    const url = this.token ? `${this.options.url}?token=${encodeURIComponent(this.token)}` : this.options.url
    const ws = new WebSocket(url)
    this.ws = ws
    // Capture `ws` in every handler and ignore events from a socket that is no
    // longer the current one — a stale socket's late close/message must not
    // clobber a newer connection (the StrictMode double-mount wedge).
    ws.addEventListener("open", () => this.onOpen(ws))
    ws.addEventListener("message", (e) => this.onMessage(ws, e.data as string))
    ws.addEventListener("close", () => this.onClose(ws))
    ws.addEventListener("error", () => ws.close())
  }

  private onOpen(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.status = "open"
    this.reconnectAttempt = 0
    this.emitStatus()
    this.send({ type: "setAuth", token: this.token })
    for (const rec of this.subs.values()) {
      if (rec.refcount > 0) this.sendSubscribe(rec)
    }
    const buffered = this.outbox
    this.outbox = []
    for (const m of buffered) this.send(m)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const ws = this.ws
    this.ws = null
    this.status = "closed"
    // A deliberate close will not reconnect, so nothing queued will ever flush.
    this.outbox = []
    this.failPending("connection lost")
    ws?.close()
    this.emitStatus()
  }

  getStatus(): ConnectionStatus {
    return this.status
  }
  onStatusChange(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  setAuth(token: string | null): void {
    if (token === this.token) return
    this.token = token
    // An identity switch must never leave the previous identity's data visible.
    // Reset every store AND clear its watermark even while offline: otherwise a
    // reconnect would resume the old watermark and the server's watermark-resume
    // (empty delta when the LSN is unchanged) would leave user A's rows on screen
    // under user B. Clearing the watermark forces a full `reset` re-send.
    for (const rec of this.subs.values()) {
      rec.store.reset()
      rec.firstDelta = true
    }
    if (this.status !== "open") return
    this.send({ type: "setAuth", token })
    for (const rec of this.subs.values()) {
      if (rec.refcount > 0) this.sendSubscribe(rec)
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.ws = null
    for (const rec of this.subs.values()) rec.subscribed = false
    // Nothing in flight can complete over a dead socket. Requests still queued in
    // the outbox survive to be delivered on reconnect (failPending skips them).
    this.failPending("connection lost")
    if (this.status !== "closed") {
      this.status = "closed"
      this.emitStatus()
    }
    if (!this.closed && this.options.reconnect !== false) {
      const base = this.options.reconnectBaseMs ?? 500
      const capped = Math.min(base * 2 ** this.reconnectAttempt++, 10_000)
      // Full jitter: spread reconnection attempts so a fleet doesn't thunder.
      const delay = capped / 2 + Math.random() * (capped / 2)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        this.connect()
      }, delay)
    }
  }

  /** Reject every in-flight request; leave still-queued (offline) requests alone. */
  private failPending(reason: string): void {
    if (this.pending.size === 0) return
    const queued = new Set<number>()
    for (const m of this.outbox) if (m.type === "mutation" || m.type === "action") queued.add(m.id)
    const err = new Error(reason)
    for (const [id, p] of this.pending) {
      if (queued.has(id)) continue
      if (p.timer !== undefined) clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(err)
    }
  }

  private emitStatus(): void {
    for (const cb of this.statusListeners) cb(this.status)
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.status === "open") {
      this.ws.send(JSON.stringify(msg))
      return
    }
    // Offline. Subscription lifecycle is rebuilt wholesale on reconnect, so
    // buffering it would double-send; only durable requests are queued.
    if (isLifecycle(msg.type) || msg.type === "ping") return
    this.outbox.push(msg)
    const max = this.options.maxOutbox ?? DEFAULT_MAX_OUTBOX
    while (this.outbox.length > max) {
      const dropped = this.outbox.shift()
      if (dropped && (dropped.type === "mutation" || dropped.type === "action")) {
        this.settlePending(dropped.id, (p) => p.reject(new Error("offline queue full; request dropped")))
      }
    }
  }

  /** Settle and remove a pending request, clearing its timeout. */
  private settlePending(id: number, apply: (p: Pending) => void): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.timer !== undefined) clearTimeout(p.timer)
    apply(p)
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  acquirePaginated<R extends Row>(
    name: string,
    args: Record<string, unknown>,
    window: PaginationOpts,
  ): { store: SubscriptionStore<R>; key: string } {
    // The window's anchor + initial size are part of the subscription identity:
    // two components over the same (name,args) but different anchors/page sizes
    // must not share one server window (they'd fight over setPagination).
    const key = `${preloadKey(name, args)}#p#${stableStringify(window)}`
    let rec = this.subs.get(key)
    if (!rec) {
      const store = new SubscriptionStore<R>()
      rec = { key, name, args, subId: `s${this.subCounter++}`, kind: "paginated", store, window, refcount: 0, subscribed: false, firstDelta: true }
      this.register(rec)
    } else {
      rec.window = window
    }
    return { store: rec.store as SubscriptionStore<R>, key }
  }

  acquireValue<T>(name: string, args: Record<string, unknown>): { store: ValueStore<T>; key: string } {
    const key = preloadKey(name, args) + "#v"
    let rec = this.subs.get(key)
    if (!rec) {
      const store = new ValueStore<T>()
      rec = { key, name, args, subId: `s${this.subCounter++}`, kind: "value", store, refcount: 0, subscribed: false, firstDelta: true }
      this.register(rec)
    }
    return { store: rec.store as ValueStore<T>, key }
  }

  /** Register a freshly-created record, hydrate it, and arm the never-retained sweep. */
  private register(rec: SubRecord): void {
    this.subs.set(rec.key, rec)
    this.bySubId.set(rec.subId, rec)
    this.hydrate(rec)
    // acquire* runs in render; a render can be discarded (StrictMode/concurrent)
    // without ever calling retain(). Sweep such never-retained records so they
    // don't leak at refcount 0 forever. retain() cancels this.
    rec.sweep = setTimeout(() => {
      rec.sweep = undefined
      if (rec.refcount === 0 && !rec.subscribed && this.subs.get(rec.key) === rec) {
        this.subs.delete(rec.key)
        this.bySubId.delete(rec.subId)
      }
    }, RELEASE_GRACE_MS)
  }

  retain(key: string): void {
    const rec = this.subs.get(key)
    if (!rec) return
    if (rec.sweep !== undefined) {
      // The record was retained after all — cancel the never-retained sweep.
      clearTimeout(rec.sweep)
      rec.sweep = undefined
    }
    if (rec.teardown !== undefined) {
      // Cancel a pending teardown — a remount reclaimed this subscription.
      clearTimeout(rec.teardown)
      rec.teardown = undefined
    }
    rec.refcount++
    if (rec.refcount === 1 && !rec.subscribed && this.status === "open") this.sendSubscribe(rec)
  }

  release(key: string): void {
    const rec = this.subs.get(key)
    if (!rec) return
    rec.refcount--
    if (rec.refcount <= 0 && rec.teardown === undefined) {
      // Defer teardown so a React StrictMode remount (effect cleanup → setup) or a
      // fast navigation can reclaim the same store/subscription without a refetch.
      rec.teardown = setTimeout(() => {
        rec.teardown = undefined
        if (rec.refcount > 0 || this.subs.get(key) !== rec) return
        if (rec.subscribed) this.send({ type: "unsubscribe", sub: rec.subId })
        this.subs.delete(key)
        this.bySubId.delete(rec.subId)
      }, RELEASE_GRACE_MS)
    }
  }

  setWindow(key: string, window: PaginationOpts): void {
    const rec = this.subs.get(key)
    if (!rec) return
    rec.window = window
    if (rec.subscribed) this.send({ type: "setPagination", sub: rec.subId, pagination: window })
  }

  private sendSubscribe(rec: SubRecord): void {
    // Never eagerly reset here: the first delta after (re)subscribe replaces the
    // window wholesale (firstDelta), so a transient reconnect swaps data in
    // atomically instead of blanking the list. The setAuth identity-switch path
    // resets its stores explicitly, where showing stale data would be wrong.
    rec.firstDelta = true
    rec.subscribed = true
    // Resume hint: if the store already holds seeded/cached/live data, tell the
    // server the watermark we last saw so it can (when able) send diffs only.
    const watermark = rec.store.watermark
    this.send({
      type: "subscribe",
      sub: rec.subId,
      name: rec.name,
      args: rec.args,
      ...(rec.window ? { pagination: rec.window } : {}),
      ...(watermark > 0 ? { watermark } : {}),
    })
  }

  /**
   * The IndexedDB cache key for a subscription. It includes the record key
   * (which encodes the window for paginated subs) and a per-identity discriminator
   * so a cached snapshot is never hydrated into a different window or a different
   * user's session (which the watermark-resume path could otherwise leave stale).
   */
  private cacheKeyFor(rec: SubRecord): string {
    const identity = this.token ? `#t:${this.token}` : ""
    return `${rec.key}${identity}`
  }

  private hydrate(rec: SubRecord): void {
    const pre = this.preloads.get(preloadKey(rec.name, rec.args))
    if (pre) {
      this.applyPreload(rec, pre)
      return
    }
    // Stale-while-revalidate from IndexedDB (async; live data replaces it). Only
    // apply if live data hasn't already arrived — otherwise a slow cache read
    // would clobber the authoritative value (the freshness guard covers both
    // store kinds, not just the paginated one).
    if (this.cache) {
      void this.cache.get<Preload>(this.cacheKeyFor(rec)).then((cached) => {
        if (cached && !rec.store.ready()) this.applyPreload(rec, cached)
      })
    }
  }

  private applyPreload(rec: SubRecord, pre: Preload): void {
    if (pre.paginated && rec.kind === "paginated") {
      const store = rec.store as SubscriptionStore
      store.seed(pre.page, pre.pk, pre.order, { total: pre.total, hasOlder: pre.hasOlder, hasNewer: pre.hasNewer, watermark: pre.watermark })
    } else if (!pre.paginated && rec.kind === "value") {
      ;(rec.store as ValueStore).seed(pre.value, pre.watermark)
    }
  }

  // ── Mutations / actions ──────────────────────────────────────────────────────

  mutation<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.request("mutation", name, args)
  }
  action<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.request("action", name, args)
  }

  private request<T>(type: "mutation" | "action", name: string, args: Record<string, unknown>): Promise<T> {
    const id = this.reqCounter++
    const promise = new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject }
      const ms = this.options.requestTimeoutMs ?? 30_000
      if (ms > 0 && Number.isFinite(ms)) {
        entry.timer = setTimeout(() => {
          this.settlePending(id, (p) => p.reject(new Error(`${type} "${name}" timed out`)))
        }, ms)
      }
      this.pending.set(id, entry)
    })
    this.send({ type, id, name, args } as ClientMessage)
    return promise
  }

  // ── Incoming ─────────────────────────────────────────────────────────────────

  private onMessage(ws: WebSocket, data: string): void {
    if (this.ws !== ws) return // event from a superseded socket
    let msg: ServerMessage
    try {
      msg = JSON.parse(data) as ServerMessage
    } catch {
      return // a malformed frame must never crash the client
    }
    switch (msg.type) {
      case "subscribed": {
        const rec = this.bySubId.get(msg.sub)
        if (rec && rec.kind === "paginated" && msg.pk && msg.order) {
          ;(rec.store as SubscriptionStore).setMeta(msg.pk, msg.order)
        }
        return
      }
      case "pageDelta": {
        const rec = this.bySubId.get(msg.sub)
        if (!rec || rec.kind !== "paginated") return
        const store = rec.store as SubscriptionStore
        // The server marks whether this delta replaces the window (a fresh full
        // send) or merges into it (a resume/incremental diff). Fall back to the
        // first-delta heuristic only for older servers that omit `reset`.
        const replace = msg.reset ?? rec.firstDelta
        store.applyDelta(msg.upserts as Row[], msg.removes, { total: msg.total, hasOlder: msg.hasOlder, hasNewer: msg.hasNewer, watermark: msg.watermark }, replace)
        rec.firstDelta = false
        if (this.cache) this.persistPaginated(rec, store)
        return
      }
      case "value": {
        const rec = this.bySubId.get(msg.sub)
        if (!rec || rec.kind !== "value") return
        ;(rec.store as ValueStore).set(msg.value, msg.watermark)
        if (this.cache) void this.cache.set(this.cacheKeyFor(rec), { paginated: false, value: msg.value, watermark: msg.watermark } satisfies Preload)
        return
      }
      case "mutationResult":
      case "actionResult": {
        this.settlePending(msg.id, (p) => p.resolve(msg.value))
        return
      }
      case "error": {
        // A request-scoped error rejects its promise; a subscription-scoped error
        // surfaces on the matching store so the hook can render an error state.
        if (typeof msg.id === "number") {
          this.settlePending(msg.id, (p) => p.reject(new Error(msg.message)))
        }
        if (typeof msg.sub === "string") {
          this.bySubId.get(msg.sub)?.store.setError(msg.message)
        }
        return
      }
      case "pong":
        return
    }
  }

  private persistPaginated(rec: SubRecord, store: SubscriptionStore): void {
    const snap = store.getSnapshot()
    const meta = store as unknown as { pkColumn: string; order: ReadonlyArray<{ column: string; desc: boolean }> }
    void this.cache?.set(this.cacheKeyFor(rec), {
      paginated: true,
      page: snap.data,
      pk: meta.pkColumn,
      order: meta.order,
      hasOlder: snap.hasOlder,
      hasNewer: snap.hasNewer,
      total: snap.total,
      watermark: store.watermark,
    } satisfies Preload)
  }
}
