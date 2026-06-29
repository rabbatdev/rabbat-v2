import { Effect, Layer } from "effect"
import {
  type ClientMessage,
  type PaginationOpts,
  type ServerMessage,
  decodeClientMessage,
} from "@rabbat/protocol"
import type { SchemaInfo } from "@rabbat/schema"
import {
  type DurableState,
  Engine,
  EngineLive,
  LsmStoreLive,
  R2BlobStore,
} from "@rabbat/engine"
import type { Identity } from "@rabbat/functions"
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
}

const STATE_KEY = "rabbat:durable-state"

/**
 * Build the `RabbatPartition` Durable Object class for an app. One instance owns
 * one partition: it is the single writer (so commits order and mutations are
 * serializable without OCC), runs the reactive engine, and holds live
 * subscriptions. The dataset lives in R2; the DO persists only the small
 * memtable + manifest to its own storage.
 */
export function definePartition(config: PartitionConfig): {
  new (ctx: DurableObjectState, env: Record<string, unknown>): DurableObject
} {
  return class RabbatPartition implements DurableObject {
    private engine!: Engine["Service"]
    private runtime!: Runtime
    private hub!: ReactiveHub
    private readonly sockets = new Map<string, WebSocket>()
    private readonly identities = new Map<string, Identity | null>()
    private connCounter = 0
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
          LsmStoreLive({ prefix: `app/${this.ctx.id.toString()}`, flushEntries: config.flushEntries }),
        ),
        Layer.provide(R2BlobStore(bucket)),
      )
      this.engine = await Effect.runPromise(Effect.provide(Engine, layer))
      const saved = (await this.ctx.storage.get<DurableState>(STATE_KEY)) ?? undefined
      if (saved) this.engine.restore(saved)
      this.runtime = new Runtime({ schema: config.schema, modules: config.modules, auth: config.auth }, this.engine)
      this.hub = new ReactiveHub(this.runtime)
    }

    async fetch(request: Request): Promise<Response> {
      await this.ready
      const url = new URL(request.url)
      if (request.headers.get("Upgrade") === "websocket") return this.acceptWs(request, url)
      if (url.pathname.endsWith("/query")) return this.httpQuery(request)
      if (url.pathname.endsWith("/mutate")) return this.httpMutate(request)
      if (url.pathname.endsWith("/lsn")) return json({ watermark: this.engine.lsn() })
      return new Response("not found", { status: 404 })
    }

    // ── WebSocket sync ──────────────────────────────────────────────────────

    private acceptWs(request: Request, url: URL): Response {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.accept()
      const conn = `c${this.connCounter++}`
      this.sockets.set(conn, server)
      const token = url.searchParams.get("token")
      void this.runtime.resolveIdentity(token).then((id) => this.identities.set(conn, id))

      server.addEventListener("message", (event) => {
        void this.onMessage(conn, server, event.data)
      })
      const drop = () => {
        this.sockets.delete(conn)
        this.identities.delete(conn)
        this.hub.removeConnection(conn)
      }
      server.addEventListener("close", drop)
      server.addEventListener("error", drop)
      return new Response(null, { status: 101, webSocket: client })
    }

    private async onMessage(conn: string, server: WebSocket, data: string | ArrayBuffer): Promise<void> {
      let msg: ClientMessage
      try {
        msg = decodeClientMessage(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)))
      } catch (e) {
        return send(server, { type: "error", message: `bad message: ${String(e)}` })
      }
      try {
        switch (msg.type) {
          case "setAuth": {
            this.identities.set(conn, await this.runtime.resolveIdentity(msg.token))
            return
          }
          case "subscribe": {
            const out = await this.hub.subscribe(
              conn,
              msg.sub,
              msg.name,
              msg.args,
              msg.pagination,
              this.identities.get(conn) ?? null,
            )
            return this.dispatch(out)
          }
          case "setPagination": {
            return this.dispatch(await this.hub.setPagination(conn, msg.sub, msg.pagination as PaginationOpts))
          }
          case "unsubscribe": {
            this.hub.unsubscribe(conn, msg.sub)
            return
          }
          case "mutation": {
            const result = await this.serialize(() =>
              this.runtime.runMutation(msg.name, msg.args, this.identities.get(conn) ?? null),
            )
            send(server, { type: "mutationResult", id: msg.id, value: result.value })
            await this.afterCommit(result.changes, result.scheduled)
            return
          }
          case "action": {
            const value = await this.runtime.runAction(msg.name, msg.args, this.identities.get(conn) ?? null)
            return send(server, { type: "actionResult", id: msg.id, value })
          }
          case "ping": {
            return send(server, { type: "pong", id: msg.id })
          }
        }
      } catch (e) {
        const id = "id" in msg ? msg.id : undefined
        const sub = "sub" in msg ? msg.sub : undefined
        send(server, { type: "error", id, sub, message: errorMessage(e) })
      }
    }

    // ── HTTP (SSR preload + conditional cache) ────────────────────────────────

    private async httpQuery(request: Request): Promise<Response> {
      const body = (await request.json()) as { name: string; args?: Record<string, unknown>; pagination?: PaginationOpts; token?: string | null }
      const ifWatermark = request.headers.get("If-Rabbat-Watermark")
      const current = this.engine.lsn()
      // Conditional read: if the partition hasn't advanced since the client's
      // snapshot, nothing it could read has changed — answer 304 without touching R2.
      if (ifWatermark !== null && Number(ifWatermark) === current) {
        return new Response(null, { status: 304, headers: { "Rabbat-Watermark": String(current) } })
      }
      const identity = await this.runtime.resolveIdentity(body.token ?? null)
      const args = body.pagination ? { ...(body.args ?? {}), paginationOpts: body.pagination } : (body.args ?? {})
      const result = await this.runtime.runQuery(body.name, args, identity)
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
      const body = (await request.json()) as { name: string; args?: Record<string, unknown>; token?: string | null }
      const identity = await this.runtime.resolveIdentity(body.token ?? null)
      const result = await this.serialize(() => this.runtime.runMutation(body.name, body.args ?? {}, identity))
      await this.afterCommit(result.changes, result.scheduled)
      return json({ value: result.value, watermark: result.lsn })
    }

    // ── Commit fan-out + durability ───────────────────────────────────────────

    private async afterCommit(
      changes: ReadonlyArray<import("@rabbat/engine").RowChange>,
      scheduled: ReadonlyArray<import("./runtime.js").ScheduledCall>,
    ): Promise<void> {
      await this.persist()
      const out = await this.hub.onCommit(changes)
      this.dispatch(out)
      if (scheduled.length > 0) {
        const due = Math.min(...scheduled.map((s) => s.at))
        await this.ctx.storage.setAlarm(due)
        const jobs = ((await this.ctx.storage.get<ScheduledJob[]>("rabbat:jobs")) ?? []).concat(
          scheduled.map((s) => ({ at: s.at, name: s.name, args: s.args })),
        )
        await this.ctx.storage.put("rabbat:jobs", jobs)
      }
    }

    async alarm(): Promise<void> {
      await this.ready
      const jobs = (await this.ctx.storage.get<ScheduledJob[]>("rabbat:jobs")) ?? []
      const now = Date.now()
      const due = jobs.filter((j) => j.at <= now)
      const rest = jobs.filter((j) => j.at > now)
      await this.ctx.storage.put("rabbat:jobs", rest)
      for (const job of due) {
        const result = await this.serialize(() => this.runtime.runMutation(job.name, job.args, null)).catch(() => null)
        if (result) await this.afterCommit(result.changes, result.scheduled)
      }
      if (rest.length > 0) await this.ctx.storage.setAlarm(Math.min(...rest.map((j) => j.at)))
    }

    private dispatch(out: Outbound[]): void {
      for (const o of out) {
        const ws = this.sockets.get(o.conn)
        if (ws) send(ws, o.message)
      }
    }

    private persist(): Promise<void> {
      return this.ctx.storage.put(STATE_KEY, this.engine.dump())
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

interface ScheduledJob {
  at: number
  name: string
  args: Record<string, unknown>
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    /* socket closing */
  }
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}
