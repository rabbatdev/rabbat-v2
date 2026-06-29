import type { Filter, PaginationOpts, Row, ServerMessage } from "@rabbat/protocol"
import type { PageOutput, RowChange } from "@rabbat/engine"
import { Subscription } from "@rabbat/engine"
import type { Identity } from "@rabbat/functions"
import type { Runtime } from "./runtime.js"

interface SubRecord {
  readonly conn: string
  readonly sub: string
  readonly name: string
  args: Record<string, unknown>
  readonly identity: Identity | null
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

  async subscribe(
    conn: string,
    sub: string,
    name: string,
    args: Record<string, unknown>,
    pagination: PaginationOpts | undefined,
    identity: Identity | null,
  ): Promise<Outbound[]> {
    const rec: SubRecord = { conn, sub, name, args, identity, paginated: false, window: pagination, deps: [] }
    this.subs.set(`${conn}/${sub}`, rec)
    return this.evaluate(rec, true)
  }

  async setPagination(conn: string, sub: string, pagination: PaginationOpts): Promise<Outbound[]> {
    const rec = this.subs.get(`${conn}/${sub}`)
    if (!rec) return []
    rec.window = pagination
    return this.evaluate(rec, false)
  }

  /** Run the query and produce the messages for its current state. */
  private async evaluate(rec: SubRecord, first: boolean): Promise<Outbound[]> {
    const args = rec.window ? { ...rec.args, paginationOpts: rec.window } : rec.args
    const result = await this.runtime.runQuery(rec.name, args, rec.identity)
    rec.deps = result.deps
    const watermark = this.runtime.lsn
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
      const delta = rec.ivm!.applyPage(page)
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
      if (first) {
        out.push({ conn: rec.conn, message: { type: "subscribed", sub: rec.sub, paginated: false } })
      }
      rec.lastValue = result.value
      out.push({ conn: rec.conn, message: { type: "value", sub: rec.sub, value: result.value, watermark } })
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
        if (!rec.ivm.windowCanChange(changes)) continue
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
  const test = (row: Row | null): boolean => row !== null && eq.every((f) => (row[f.column] ?? null) === f.value)
  return test(change.after) || test(change.before)
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
