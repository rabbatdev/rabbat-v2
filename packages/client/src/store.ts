import { type OrderKey, type Row, type Scalar, compareRows } from "@rabbat/protocol"

export type SubStatus = "loading" | "ready"

export interface Snapshot<R extends Row = Row> {
  /** Rows in the subscription's sort order. */
  readonly data: ReadonlyArray<R>
  readonly status: SubStatus
  /** Total rows matching the filter on the server (may exceed the window). */
  readonly total: number
  /** Whether more rows exist before / after the loaded window (both scroll dirs). */
  readonly hasOlder: boolean
  readonly hasNewer: boolean
}

const pkStr = (v: Scalar): string => `${typeof v}:${String(v)}`

/**
 * The client-side mirror of one paginated subscription. It keeps the window
 * sorted and applies each `pageDelta` incrementally — splicing upserts into sort
 * position (binary search) and removing departed keys — so the ordered list is
 * never re-sent or re-sorted wholesale. Exposes a `useSyncExternalStore`-shaped
 * `subscribe` / `getSnapshot`.
 */
export class SubscriptionStore<R extends Row = Row> {
  private rows = new Map<string, R>()
  private sorted: R[] = []
  private pkColumn = "id"
  private order: ReadonlyArray<OrderKey> = []
  private status: SubStatus = "loading"
  private total = 0
  private hasOlder = false
  private hasNewer = false
  private snapshot: Snapshot<R> = { data: [], status: "loading", total: 0, hasOlder: false, hasNewer: false }
  private listeners = new Set<() => void>()
  /** Watermark (partition LSN) of the last applied delta — for SSR resume / cache. */
  watermark = 0

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot = (): Snapshot<R> => this.snapshot

  setMeta(pk: string, order: ReadonlyArray<OrderKey>): void {
    this.pkColumn = pk
    this.order = order
  }

  ready(): boolean {
    return this.status === "ready"
  }

  /** Seed from an SSR preload or IndexedDB cache (stays "loading" until live). */
  seed(rows: ReadonlyArray<R>, pk: string, order: ReadonlyArray<OrderKey>, meta: Meta): void {
    this.setMeta(pk, order)
    this.rows.clear()
    this.sorted = []
    for (const row of rows) {
      this.rows.set(pkStr(row[pk] ?? null), row)
    }
    this.sorted = [...rows].sort((a, b) => compareRows(a, b, this.order))
    this.total = meta.total
    this.hasOlder = meta.hasOlder
    this.hasNewer = meta.hasNewer
    this.recompute()
  }

  applyDelta(upserts: ReadonlyArray<R>, removes: ReadonlyArray<Scalar>, meta: Meta, replace = false): void {
    if (replace) {
      this.rows.clear()
      this.sorted = []
    }
    for (const pk of removes) {
      const key = pkStr(pk)
      const old = this.rows.get(key)
      if (old) {
        this.rows.delete(key)
        this.removeFromSorted(old)
      }
    }
    for (const row of upserts) {
      const key = pkStr(row[this.pkColumn] ?? null)
      const old = this.rows.get(key)
      if (old) this.removeFromSorted(old)
      this.rows.set(key, row)
      this.insertSorted(row)
    }
    this.total = meta.total
    this.hasOlder = meta.hasOlder
    this.hasNewer = meta.hasNewer
    this.status = "ready"
    this.watermark = meta.watermark ?? this.watermark
    this.recompute()
  }

  reset(): void {
    this.rows.clear()
    this.sorted = []
    this.status = "loading"
    this.recompute()
  }

  private insertSorted(row: R): void {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareRows(this.sorted[mid]!, row, this.order) < 0) lo = mid + 1
      else hi = mid
    }
    this.sorted.splice(lo, 0, row)
  }

  private removeFromSorted(row: R): void {
    // The row may have moved; find by pk near its sorted position, then linear-fallback.
    const key = pkStr(row[this.pkColumn] ?? null)
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareRows(this.sorted[mid]!, row, this.order) < 0) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < this.sorted.length; i++) {
      if (pkStr(this.sorted[i]![this.pkColumn] ?? null) === key) {
        this.sorted.splice(i, 1)
        return
      }
      if (compareRows(this.sorted[i]!, row, this.order) > 0) break
    }
    const idx = this.sorted.findIndex((r) => pkStr(r[this.pkColumn] ?? null) === key)
    if (idx >= 0) this.sorted.splice(idx, 1)
  }

  private recompute(): void {
    this.snapshot = {
      data: this.sorted.slice(),
      status: this.status,
      total: this.total,
      hasOlder: this.hasOlder,
      hasNewer: this.hasNewer,
    }
    for (const cb of this.listeners) cb()
  }
}

export interface Meta {
  readonly total: number
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly watermark?: number
}

export interface ValueSnapshot<T> {
  readonly data: T | undefined
  readonly status: SubStatus
}

/** The client-side mirror of a non-paginated (whole-value) reactive query. */
export class ValueStore<T = unknown> {
  private snapshot: ValueSnapshot<T> = { data: undefined, status: "loading" }
  private listeners = new Set<() => void>()
  watermark = 0

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  getSnapshot = (): ValueSnapshot<T> => this.snapshot

  set(value: T, watermark?: number): void {
    this.snapshot = { data: value, status: "ready" }
    if (watermark !== undefined) this.watermark = watermark
    this.emit()
  }
  seed(value: T): void {
    this.snapshot = { data: value, status: "loading" }
    this.emit()
  }
  reset(): void {
    this.snapshot = { data: this.snapshot.data, status: "loading" }
    this.emit()
  }
  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}
