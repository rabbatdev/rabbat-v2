import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ValueCache } from "@rabbat/client"

// ── A minimal in-memory IndexedDB double ────────────────────────────────────
// Node has no IndexedDB; this implements exactly the surface ValueCache touches
// (open/upgrade, get, put, count, clear, and an ascending-`t` index cursor) so
// the LRU recency + version-bump behaviour can be exercised for real.

interface FakeStore {
  keyPath: string
  data: Map<string, { k: string; v: unknown; t: number }>
}
interface FakeDB {
  version: number
  stores: Map<string, FakeStore>
}

const dbs = new Map<string, FakeDB>()

function makeStoreHandle(store: FakeStore) {
  return {
    get(key: string) {
      const req: any = {}
      queueMicrotask(() => {
        req.result = store.data.get(key)
        req.onsuccess?.()
      })
      return req
    },
    put(row: { k: string; v: unknown; t: number }) {
      store.data.set(row.k, row)
    },
    count() {
      const req: any = {}
      queueMicrotask(() => {
        req.result = store.data.size
        req.onsuccess?.()
      })
      return req
    },
    clear() {
      store.data.clear()
    },
    createIndex() {
      /* index maintained implicitly by sorting on read */
    },
    index(_name: string) {
      return {
        openCursor() {
          const req: any = {}
          const rows = [...store.data.values()].sort((a, b) => a.t - b.t)
          let i = 0
          const step = () => {
            if (i >= rows.length) {
              req.result = null
              req.onsuccess?.()
              return
            }
            const row = rows[i]!
            req.result = {
              value: row,
              delete: () => store.data.delete(row.k),
              continue: () => {
                i++
                queueMicrotask(step)
              },
            }
            req.onsuccess?.()
          }
          queueMicrotask(step)
          return req
        },
      }
    },
  }
}

const fakeIndexedDB = {
  open(name: string, version: number) {
    const req: any = {}
    queueMicrotask(() => {
      let db = dbs.get(name)
      const oldVersion = db?.version ?? 0
      if (!db) {
        db = { version, stores: new Map() }
        dbs.set(name, db)
      }
      const handle = {
        objectStoreNames: { contains: (n: string) => db!.stores.has(n) },
        createObjectStore(n: string, opts: { keyPath: string }) {
          const store: FakeStore = { keyPath: opts.keyPath, data: new Map() }
          db!.stores.set(n, store)
          return makeStoreHandle(store)
        },
        transaction(n: string) {
          const tx: any = { objectStore: () => makeStoreHandle(db!.stores.get(n)!) }
          queueMicrotask(() => tx.oncomplete?.())
          return tx
        },
      }
      if (version > oldVersion) {
        db.version = version
        req.result = handle
        req.transaction = { objectStore: (n: string) => makeStoreHandle(db!.stores.get(n)!) }
        req.onupgradeneeded?.({ oldVersion })
        req.transaction = null
      }
      req.result = handle
      req.onsuccess?.()
    })
    return req
  },
}

beforeEach(() => {
  dbs.clear()
  ;(globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB
})
afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB
})

describe("ValueCache LRU", () => {
  it("evicts the genuinely-oldest entries and preserves ones touched by a read", async () => {
    const cache = new ValueCache({ name: "lru", maxEntries: 8 })
    // Write 15 entries (no trim yet — trim amortizes every 16 writes).
    for (let i = 0; i < 15; i++) await cache.set(`k${i}`, i)
    // A read bumps recency: k0 becomes the most-recently-used.
    await cache.get("k0")
    // The 16th write triggers a trim: count 16, evict the 8 oldest by `t`.
    await cache.set("k15", 15)

    expect(await cache.get("k0")).toBe(0) // touched → survives despite being written first
    expect(await cache.get("k1")).toBeUndefined() // oldest untouched → evicted
    expect(await cache.get("k9")).toBe(9) // recent → survives
  })
})

describe("ValueCache version", () => {
  it("discards incompatible cached snapshots when the version is bumped", async () => {
    const v1 = new ValueCache({ name: "verdb", version: 1 })
    await v1.set("a", "old")
    expect(await v1.get("a")).toBe("old")

    const v2 = new ValueCache({ name: "verdb", version: 2 })
    expect(await v2.get("a")).toBeUndefined() // cleared on upgrade
  })

  it("keeps cached snapshots when the version is unchanged", async () => {
    const a = new ValueCache({ name: "samedb", version: 3 })
    await a.set("a", "keep")
    const b = new ValueCache({ name: "samedb", version: 3 })
    expect(await b.get("a")).toBe("keep")
  })
})
