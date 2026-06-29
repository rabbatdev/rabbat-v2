import type { ClientMessage, PaginationOpts, Row, ServerMessage } from "@rabbat/protocol"
import { ValueCache, type ValueCacheOptions } from "./cache.js"
import { SubscriptionStore, ValueStore } from "./store.js"

export type ConnectionStatus = "connecting" | "open" | "closed"

/** The cache/preload key for a (function, args) pair. */
export function preloadKey(name: string, args: unknown): string {
  return JSON.stringify([name, args])
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
}

/** How long a subscription lingers at refcount 0 before teardown (survives StrictMode). */
const RELEASE_GRACE_MS = 300

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
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private outbox: ClientMessage[] = []
  private reconnectAttempt = 0
  private token: string | null
  private readonly cache?: ValueCache

  constructor(private readonly options: FunctionsClientOptions) {
    this.token = options.token ?? null
    if (options.persist) {
      this.cache = new ValueCache(typeof options.persist === "object" ? options.persist : {})
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws || typeof WebSocket === "undefined") return
    this.status = "connecting"
    this.emitStatus()
    const url = this.token ? `${this.options.url}?token=${encodeURIComponent(this.token)}` : this.options.url
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener("open", () => {
      this.status = "open"
      this.reconnectAttempt = 0
      this.emitStatus()
      this.send({ type: "setAuth", token: this.token })
      for (const rec of this.subs.values()) {
        if (rec.refcount > 0) this.sendSubscribe(rec, true)
      }
      const buffered = this.outbox
      this.outbox = []
      for (const m of buffered) this.send(m)
    })
    ws.addEventListener("message", (e) => this.onMessage(e.data as string))
    ws.addEventListener("close", () => this.onClose())
    ws.addEventListener("error", () => ws.close())
  }

  close(): void {
    this.options.reconnect && (this.reconnectAttempt = -1) // disable reconnect
    this.ws?.close()
    this.ws = null
    this.status = "closed"
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
    this.token = token
    this.send({ type: "setAuth", token })
    // Re-subscribe so results reflect the new identity.
    for (const rec of this.subs.values()) {
      if (rec.refcount > 0) {
        rec.store.reset()
        rec.firstDelta = true
        this.sendSubscribe(rec, true)
      }
    }
  }

  private onClose(): void {
    this.ws = null
    for (const rec of this.subs.values()) rec.subscribed = false
    if (this.status !== "closed") {
      this.status = "closed"
      this.emitStatus()
    }
    if (this.options.reconnect !== false && this.reconnectAttempt >= 0) {
      const base = this.options.reconnectBaseMs ?? 500
      const delay = Math.min(base * 2 ** this.reconnectAttempt++, 10_000)
      setTimeout(() => this.connect(), delay)
    }
  }

  private emitStatus(): void {
    for (const cb of this.statusListeners) cb(this.status)
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.status === "open") this.ws.send(JSON.stringify(msg))
    else this.outbox.push(msg)
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  acquirePaginated<R extends Row>(
    name: string,
    args: Record<string, unknown>,
    window: PaginationOpts,
  ): { store: SubscriptionStore<R>; key: string } {
    const key = preloadKey(name, args) + "#p"
    let rec = this.subs.get(key)
    if (!rec) {
      const store = new SubscriptionStore<R>()
      rec = { key, name, args, subId: `s${this.subCounter++}`, kind: "paginated", store, window, refcount: 0, subscribed: false, firstDelta: true }
      this.subs.set(key, rec)
      this.bySubId.set(rec.subId, rec)
      this.hydrate(rec)
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
      this.subs.set(key, rec)
      this.bySubId.set(rec.subId, rec)
      this.hydrate(rec)
    }
    return { store: rec.store as ValueStore<T>, key }
  }

  retain(key: string): void {
    const rec = this.subs.get(key)
    if (!rec) return
    if (rec.teardown !== undefined) {
      // Cancel a pending teardown — a remount reclaimed this subscription.
      clearTimeout(rec.teardown)
      rec.teardown = undefined
    }
    rec.refcount++
    if (rec.refcount === 1 && !rec.subscribed && this.status === "open") this.sendSubscribe(rec, false)
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

  private sendSubscribe(rec: SubRecord, reset: boolean): void {
    if (reset && rec.kind === "paginated") (rec.store as SubscriptionStore).reset()
    rec.firstDelta = true
    rec.subscribed = true
    this.send({ type: "subscribe", sub: rec.subId, name: rec.name, args: rec.args, ...(rec.window ? { pagination: rec.window } : {}) })
  }

  private hydrate(rec: SubRecord): void {
    const pre = this.options.preloaded?.[preloadKey(rec.name, rec.args)]
    if (pre) {
      this.applyPreload(rec, pre)
      return
    }
    // Stale-while-revalidate from IndexedDB (async; live data replaces it).
    if (this.cache) {
      void this.cache.get<Preload>(preloadKey(rec.name, rec.args)).then((cached) => {
        if (cached && (rec.kind === "paginated" ? !(rec.store as SubscriptionStore).ready() : true)) {
          this.applyPreload(rec, cached)
        }
      })
    }
  }

  private applyPreload(rec: SubRecord, pre: Preload): void {
    if (pre.paginated && rec.kind === "paginated") {
      const store = rec.store as SubscriptionStore
      store.seed(pre.page, pre.pk, pre.order, { total: pre.total, hasOlder: pre.hasOlder, hasNewer: pre.hasNewer, watermark: pre.watermark })
    } else if (!pre.paginated && rec.kind === "value") {
      ;(rec.store as ValueStore).seed(pre.value)
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
    this.send({ type, id, name, args } as ClientMessage)
    return promise
  }

  // ── Incoming ─────────────────────────────────────────────────────────────────

  private onMessage(data: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(data) as ServerMessage
    } catch {
      return
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
        store.applyDelta(msg.upserts as Row[], msg.removes, { total: msg.total, hasOlder: msg.hasOlder, hasNewer: msg.hasNewer, watermark: msg.watermark }, rec.firstDelta)
        rec.firstDelta = false
        if (this.cache) this.persistPaginated(rec, store)
        return
      }
      case "value": {
        const rec = this.bySubId.get(msg.sub)
        if (!rec || rec.kind !== "value") return
        ;(rec.store as ValueStore).set(msg.value, msg.watermark)
        if (this.cache) void this.cache.set(preloadKey(rec.name, rec.args), { paginated: false, value: msg.value, watermark: msg.watermark } satisfies Preload)
        return
      }
      case "mutationResult":
      case "actionResult": {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.resolve(msg.value)
        }
        return
      }
      case "error": {
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            p.reject(new Error(msg.message))
          }
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
    void this.cache?.set(preloadKey(rec.name, rec.args), {
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
