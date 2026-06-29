import type { OrderKey, Row, Scalar } from "@rabbat/protocol"
import { compareRows } from "@rabbat/protocol"
import type { RowChange, PageOutput } from "./engine.js"
import { type Filter, type QuerySpec, equalityBindings, matchesRow } from "./query.js"

export interface Delta {
  readonly upserts: ReadonlyArray<Row>
  readonly removes: ReadonlyArray<Scalar>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly total: number
  /** False when re-materializing produced no observable change (skip the send). */
  readonly changed: boolean
}

const pkStr = (v: Scalar): string => `${typeof v}:${String(v)}`

/**
 * The live, incrementally-maintained state of one subscription's window. Holds
 * the rows last sent to the client so a re-materialized window can be diffed
 * down to `upserts` + `removes`; the ordered result list is never re-sent.
 */
export class Subscription {
  private readonly eqBindings: Array<{ column: string; value: Scalar }>
  private last: Map<string, Row> = new Map()
  private order: ReadonlyArray<OrderKey>
  private lo: Row | null = null
  private hi: Row | null = null
  private hasOlder = false
  private hasNewer = false
  private total = 0
  private seeded = false

  constructor(
    readonly spec: QuerySpec,
    order: ReadonlyArray<OrderKey>,
  ) {
    this.order = order
    this.eqBindings = equalityBindings(spec)
  }

  get filters(): ReadonlyArray<Filter> {
    return this.spec.filters
  }

  /** Does a write to this row's group concern this subscription at all? */
  private inGroup(change: RowChange): boolean {
    if (change.table !== this.spec.table) return false
    if (this.eqBindings.length === 0) return true
    const test = (row: Row | null): boolean =>
      row !== null && this.eqBindings.every((b) => (row[b.column] ?? null) === b.value)
    return test(change.after) || test(change.before)
  }

  /**
   * Quick reject: can any of these changes possibly alter the visible window?
   * Returns true when in doubt (a re-materialize is then done and diffed), and
   * false only when a change provably lands outside the loaded window with more
   * rows already known to exist on that side.
   */
  windowCanChange(changes: ReadonlyArray<RowChange>): boolean {
    if (!this.seeded) return true
    for (const change of changes) {
      if (!this.inGroup(change)) continue
      const cand =
        change.after && matchesRow(change.after, this.filters)
          ? change.after
          : change.before && matchesRow(change.before, this.filters)
            ? change.before
            : null
      if (!cand) continue
      if (change.before && this.visibleByPk(change.pk)) return true
      if (this.withinSpan(cand)) return true
    }
    return false
  }

  private visibleByPk(pk: Scalar): boolean {
    return this.last.has(pkStr(pk))
  }

  private withinSpan(row: Row): boolean {
    const belowTop = this.lo !== null && compareRows(row, this.lo, this.order) < 0
    const aboveBottom = this.hi !== null && compareRows(row, this.hi, this.order) > 0
    if (belowTop && this.hasOlder) return false
    if (aboveBottom && this.hasNewer) return false
    return true
  }

  /** Diff a freshly materialized page against what the client last saw. */
  applyPage(page: PageOutput): Delta {
    const pk = page.pk
    this.order = page.order
    const next = new Map<string, Row>()
    const upserts: Row[] = []
    for (const row of page.rows) {
      const key = pkStr(row[pk] ?? null)
      next.set(key, row)
      const prev = this.last.get(key)
      if (!prev || !rowsEqual(prev, row)) upserts.push(row)
    }
    const removes: Scalar[] = []
    for (const [key, row] of this.last) {
      if (!next.has(key)) removes.push(row[pk] ?? null)
    }
    const metaChanged =
      this.hasOlder !== page.hasOlder || this.hasNewer !== page.hasNewer || this.total !== page.total

    this.last = next
    this.lo = page.rows.length ? page.rows[0]! : null
    this.hi = page.rows.length ? page.rows[page.rows.length - 1]! : null
    this.hasOlder = page.hasOlder
    this.hasNewer = page.hasNewer
    this.total = page.total
    this.seeded = true

    return {
      upserts,
      removes,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      total: page.total,
      changed: upserts.length > 0 || removes.length > 0 || metaChanged,
    }
  }
}

function rowsEqual(a: Row, b: Row): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}
