import { describe, expect, it } from "vitest"
import { SubscriptionStore, ValueStore } from "@rabbat/client"

describe("ValueStore freshness + status", () => {
  it("only reports ready() once live data arrives (seed stays loading)", () => {
    const store = new ValueStore<number>()
    expect(store.ready()).toBe(false)

    store.seed(1, 5) // SSR/cache seed
    expect(store.ready()).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ data: 1, status: "loading" })
    expect(store.watermark).toBe(5)

    store.set(2, 9) // live
    expect(store.ready()).toBe(true)
    expect(store.watermark).toBe(9)
  })

  it("reset clears the watermark meta but keeps the last value visible", () => {
    const store = new ValueStore<number>()
    store.set(2, 9)
    store.reset()
    expect(store.watermark).toBe(0)
    expect(store.ready()).toBe(false)
    expect(store.getSnapshot().data).toBe(2)
  })

  it("setError surfaces an error status with the message", () => {
    const store = new ValueStore<number>()
    store.set(7)
    store.setError("boom")
    const snap = store.getSnapshot()
    expect(snap.status).toBe("error")
    expect(snap.error).toBe("boom")
    expect(snap.data).toBe(7) // last value stays visible
  })
})

describe("SubscriptionStore freshness + status", () => {
  const meta = (watermark: number) => ({ total: 0, hasOlder: false, hasNewer: false, watermark })

  it("seed stays loading and sets the watermark for resume", () => {
    const store = new SubscriptionStore()
    store.seed([], "id", [], meta(4))
    expect(store.ready()).toBe(false)
    expect(store.watermark).toBe(4)
  })

  it("applyDelta clears any error and goes ready", () => {
    const store = new SubscriptionStore()
    store.setError("nope")
    expect(store.getSnapshot().status).toBe("error")
    store.applyDelta([], [], meta(1), true)
    const snap = store.getSnapshot()
    expect(snap.status).toBe("ready")
    expect(snap.error).toBeUndefined()
  })

  it("reset returns to loading and clears the watermark", () => {
    const store = new SubscriptionStore()
    store.applyDelta([], [], meta(3), true)
    store.reset()
    expect(store.ready()).toBe(false)
    expect(store.watermark).toBe(0)
  })
})
