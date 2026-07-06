import { type Filter, type PaginationOpts, type Row, type ServerMessage, compareScalar } from "@rabbat/protocol"
import type { PageOutput, RowChange } from "@rabbat/engine"
import { Subscription } from "@rabbat/engine"
import type { Identity } from "@rabbat/functions"
import type { Runtime } from "./runtime.js"

/** Max live subscriptions one connection may hold (backpressure / abuse guard). */
export const MAX_SUBS_PER_CONN = 256

interface SubRecord {
  readonly conn: string
  readonly sub: string
  readonly name: string
  args: Record<string, unknown>
  /** Mutable: `setAuth` re-binds live subscriptions to the new identity. */
  identity: Identity | null
  paginated: boolean
  window?: PaginationOpts
  ivm?: Subscription
  deps: ReadonlyArray<{ table: string; filters: ReadonlyArray<Filter> }>
  lastValue?: unknown
}

export interface Outbound {
  readonly conn: string
  readonly message: ServerMessage
}

/**
 * Holds every live subscription for one partition and turns a commit's row
 * changes into the minimal set of outbound messages. Paginated subscriptions are
 * diffed incrementally by the engine's IVM; value subscriptions re-run only when
 * a change matches a dependency they read.
 */
export class ReactiveHub {
  private readonly subs = new Map<string, SubRecord>()

  constructor(private readonly runtime: Runtime) {}

  /** Subscriptions tracked, for metrics. */
  get size(): number {
    return this.subs.size
  }

  removeConnection(conn: string): void {
    for (const [key, rec] of this.subs) if (rec.conn === conn) this.subs.delete(key)
  }

  unsubscribe(conn: string, sub: string): void {
    this.subs.delete(`${conn}/${sub}`)
  }

  private countForConn(conn: string): number {
    let n = 0
    for (const rec of this.subs.values()) if (rec.conn === conn) n++
    return n
  }

  async subscribe(
    conn: string,
    sub: string,
    name: string,
    args: Record<string, unknown>,
    pagination: PaginationOpts | undefined,
    identity: Identity | null,
    resumeAt?: number,
  ): Promise<Outbound[]> {
    const key = `${conn}/${sub}`
    // Re-subscribing the same sub id replaces the old record (no leak).
    if (!this.subs.has(key) && this.countForConn(conn) >= MAX_SUBS_PER_CONN) {
      throw new Error(`subscription limit reached (${MAX_SUBS_PER_CONN} per connection)`)
    }
    const rec: SubRecord = { conn, sub, name, args, identity, paginated: false, window: pagination, deps: [] }
    // Evaluate FIRST; only register once the initial query succeeds, so a failing
    // subscribe (bad args, auth denial) never leaves a phantom record behind.
    const out = await this.evaluate(rec, true, resumeAt)
    this.subs.set(key, rec)
    return out
  }

  /**
   * Re-bind every subscription on a connection to a new identity (login/logout).
   * Each is re-evaluated under the new identity and the diff is sent, so a
   * subscription can never keep streaming a previous user's private rows.
   */
  async reauth(conn: string, identity: Identity | null): Promise<Outbound[]> {
    const out: Outbound[] = []
    for (const rec of this.subs.values()) {
      if (rec.conn !== conn) continue
      rec.identity = identity
      // Reset IVM/value baseline so the client gets a full, correct re-send.
      rec.ivm = undefined
      rec.lastValue = undefined
      rec.paginated = false
      try {
        out.push(...(await this.evaluate(rec, true)))
      } catch (e) {
        out.push({ conn, message: { type: "error", sub: rec.sub, message: errMsg(e) } })
        this.subs.delete(`${conn}/${rec.sub}`)
      }
    }
    return out
  }

  async setPagination(conn: string, sub: string, pagination: PaginationOpts): Promise<Outbound[]> {
    const rec = this.subs.get(`${conn}/${sub}`)
    if (!rec) return []
    rec.window = pagination
    return this.evaluate(rec, false)
  }

  /** Run the query and produce the messages for its current state. */
  private async evaluate(rec: SubRecord, first: boolean, resumeAt?: number): Promise<Outbound[]> {
    const args = rec.window ? { ...rec.args, paginationOpts: rec.window } : rec.args
    // Capture the watermark as a lower bound BEFORE the read: if a commit
    // interleaves during the async query, the payload may reflect newer state
    // than this LSN, so a client resuming from it re-receives (never misses)
    // that commit. Labeling it with a later LSN would be the unsafe direction.
    const watermark = this.runtime.lsn
    // Watermark resume: if the client already holds this query's snapshot at the
    // current LSN (SSR preload / reconnect), the materialization here is
    // byte-identical to what it has — so seed the IVM baseline and send only
    // metadata, never re-transmitting the window. Any subsequent commit advances
    // the LSN and disables this path.
    const resume = first && resumeAt !== undefined && resumeAt === watermark
    const result = await this.runtime.runQuery(rec.name, args, rec.identity)
    rec.deps = result.deps
    const out: Outbound[] = []

    if (result.paginated && result.captured) {
      const cap = result.captured
      if (first || !rec.ivm) {
        rec.paginated = true
        rec.ivm = new Subscription(cap.spec, cap.order)
        out.push({ conn: rec.conn, message: { type: "subscribed", sub: rec.sub, paginated: true, pk: cap.pk, order: cap.order } })
      }
      const page: PageOutput = {
        rows: cap.page.page as Row[],
        pk: cap.pk,
        order: cap.order,
        hasOlder: cap.page.hasOlder,
        hasNewer: cap.page.hasNewer,
        total: cap.page.total,
      }
      const delta = resume ? rec.ivm!.seedBaseline(page) : rec.ivm!.applyPage(page)
      out.push({
        conn: rec.conn,
        message: {
          type: "pageDelta",
          sub: rec.sub,
          upserts: delta.upserts,
          removes: delta.removes,
          hasOlder: delta.hasOlder,
          hasNewer: delta.hasNewer,
          total: delta.total,
          watermark,
          // A fresh full send (first, non-resume) replaces the client's window;
          // a resume or a re-materialized diff merges.
          reset: first && !resume,
        },
      })
    } else {
      if (first) {
        out.push({ conn: rec.conn, message: { type: "subscribed", sub: rec.sub, paginated: false } })
      }
      rec.lastValue = result.value
      // On resume the client already has this value; skip re-sending it.
      if (!resume) {
        out.push({ conn: rec.conn, message: { type: "value", sub: rec.sub, value: result.value, watermark } })
      }
    }
    return out
  }

  /**
   * After a commit, produce the messages whose subscriptions actually changed.
   * Paginated subs use the IVM quick-reject; value subs re-run only on a matching
   * dependency change and emit only if the value differs.
   */
  async onCommit(changes: ReadonlyArray<RowChange>): Promise<Outbound[]> {
    const out: Outbound[] = []
    const watermark = this.runtime.lsn
    for (const rec of this.subs.values()) {
      if (rec.paginated && rec.ivm) {
        if (!rec.ivm.windowCanChange(changes)) {
          // The visible rows can't change, but an off-window insert/delete may
          // still change `total` — emit a metadata-only delta if so.
          const meta = rec.ivm.totalOnlyDelta(changes)
          if (meta) {
            out.push({
              conn: rec.conn,
              message: {
                type: "pageDelta",
                sub: rec.sub,
                upserts: meta.upserts,
                removes: meta.removes,
                hasOlder: meta.hasOlder,
                hasNewer: meta.hasNewer,
                total: meta.total,
                watermark,
              },
            })
          }
          continue
        }
        const args = rec.window ? { ...rec.args, paginationOpts: rec.window } : rec.args
        const result = await this.runtime.runQuery(rec.name, args, rec.identity)
        if (!result.captured) continue
        const cap = result.captured
        const page: PageOutput = {
          rows: cap.page.page as Row[],
          pk: cap.pk,
          order: cap.order,
          hasOlder: cap.page.hasOlder,
          hasNewer: cap.page.hasNewer,
          total: cap.page.total,
        }
        const delta = rec.ivm.applyPage(page)
        if (!delta.changed) continue
        out.push({
          conn: rec.conn,
          message: {
            type: "pageDelta",
            sub: rec.sub,
            upserts: delta.upserts,
            removes: delta.removes,
            hasOlder: delta.hasOlder,
            hasNewer: delta.hasNewer,
            total: delta.total,
            watermark,
          },
        })
      } else {
        if (!changes.some((c) => rec.deps.some((d) => changeMatchesDep(c, d)))) continue
        const result = await this.runtime.runQuery(rec.name, rec.args, rec.identity)
        rec.deps = result.deps
        if (jsonEqual(rec.lastValue, result.value)) continue
        rec.lastValue = result.value
        out.push({ conn: rec.conn, message: { type: "value", sub: rec.sub, value: result.value, watermark } })
      }
    }
    return out
  }
}

function changeMatchesDep(change: RowChange, dep: { table: string; filters: ReadonlyArray<Filter> }): boolean {
  if (change.table !== dep.table) return false
  const eq = dep.filters.filter((f) => f.op === "=" && !Array.isArray(f.value))
  // Use the same total scalar comparison the engine sorts by, so routing never
  // silently misses a matching change on a `-0`/type-edge value.
  const test = (row: Row | null): boolean =>
    row !== null && eq.every((f) => compareScalar(row[f.column] ?? null, f.value as never) === 0)
  return test(change.after) || test(change.before)
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
