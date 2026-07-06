import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FunctionsClient, preloadKey, type Preload } from "@rabbat/client"

/** WebSocket stand-in: records frames, lets tests drive open/close/message events. */
class MockWS {
  static instances: MockWS[] = []
  sent: Array<Record<string, unknown>> = []
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(readonly url: string) {
    MockWS.instances.push(this)
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.fire("close", { code: 1000, reason: "" })
  }
  private fire(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
  open(): void {
    this.fire("open", {})
  }
  message(obj: unknown): void {
    this.fire("message", { data: JSON.stringify(obj) })
  }
  raw(data: string): void {
    this.fire("message", { data })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWS.instances = []
  ;(globalThis as { WebSocket?: unknown }).WebSocket = MockWS as unknown
})
afterEach(() => {
  vi.useRealTimers()
})

describe("reconnect lifecycle", () => {
  it("close() disables reconnect even with default (undefined) options", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" }) // no reconnect field
    client.connect()
    MockWS.instances[0]!.open()
    client.close()
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances).toHaveLength(1) // no new socket
    expect(client.getStatus()).toBe("closed")
  })

  it("a transport drop reconnects under default options", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    MockWS.instances[0]!.close() // server-side drop
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances.length).toBeGreaterThanOrEqual(2)
  })

  it("ignores a stale socket's late close/message after reconnect", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    const ws0 = MockWS.instances[0]!
    ws0.open()
    ws0.close() // drop → schedules reconnect
    vi.advanceTimersByTime(60_000)
    const ws1 = MockWS.instances[1]!
    ws1.open()
    expect(client.getStatus()).toBe("open")

    const before = MockWS.instances.length
    ws0.close() // stale event from the superseded socket
    ws0.message({ type: "pong", id: 1 })
    vi.advanceTimersByTime(60_000)
    expect(client.getStatus()).toBe("open") // not clobbered
    expect(MockWS.instances.length).toBe(before) // no reconnect from the stale close
  })
})

describe("pending requests", () => {
  it("rejects in-flight mutations on close()", async () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    const p = client.mutation("m", {})
    const assertion = expect(p).rejects.toThrow("connection lost")
    client.close()
    await assertion
  })

  it("rejects in-flight mutations on a transport drop", async () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    const p = client.mutation("m", {})
    const assertion = expect(p).rejects.toThrow("connection lost")
    MockWS.instances[0]!.close()
    await assertion
  })

  it("queues an offline mutation and delivers it on reconnect (not rejected on drop)", async () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    MockWS.instances[0]!.close() // now disconnected; reconnect scheduled
    const p = client.mutation("m", { a: 1 }) // buffered in the outbox

    vi.advanceTimersByTime(1000) // past the reconnect backoff, before any request timeout
    const ws1 = MockWS.instances[1]!
    ws1.open() // flushes the outbox
    const sent = ws1.sent.find((f) => f.type === "mutation")!
    expect(sent).toBeDefined()
    ws1.message({ type: "mutationResult", id: sent.id, value: 42 })
    await expect(p).resolves.toBe(42)
  })

  it("times out a request that never gets a response", async () => {
    const client = new FunctionsClient({ url: "ws://x/ws", requestTimeoutMs: 1000 })
    client.connect()
    MockWS.instances[0]!.open()
    const p = client.mutation("m", {})
    const assertion = expect(p).rejects.toThrow(/timed out/)
    vi.advanceTimersByTime(1500)
    await assertion
  })
})

describe("subscribe watermark resume", () => {
  it("includes the seeded watermark in the subscribe frame", () => {
    const key = preloadKey("channels:list", {})
    const preloaded: Record<string, Preload> = { [key]: { paginated: false, value: [1], watermark: 7 } }
    const client = new FunctionsClient({ url: "ws://x/ws", preloaded })
    client.connect()
    const acquired = client.acquireValue("channels:list", {})
    client.retain(acquired.key)
    MockWS.instances[0]!.open() // resubscribe on open
    const sub = MockWS.instances[0]!.sent.find((f) => f.type === "subscribe")!
    expect(sub.watermark).toBe(7)
  })

  it("omits the watermark when the store has no seeded data", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    const acquired = client.acquireValue("channels:list", {})
    client.retain(acquired.key)
    MockWS.instances[0]!.open()
    const sub = MockWS.instances[0]!.sent.find((f) => f.type === "subscribe")!
    expect("watermark" in sub).toBe(false)
  })
})

describe("subscription errors", () => {
  it("routes an error frame carrying `sub` into the matching store", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    const { store, key } = client.acquireValue("channels:list", {})
    client.retain(key)
    MockWS.instances[0]!.open()
    const sub = MockWS.instances[0]!.sent.find((f) => f.type === "subscribe")!
    MockWS.instances[0]!.message({ type: "error", sub: sub.sub, message: "boom" })
    const snap = store.getSnapshot()
    expect(snap.status).toBe("error")
    expect(snap.error).toBe("boom")
  })

  it("does not crash on a malformed frame", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    expect(() => MockWS.instances[0]!.raw("{not json")).not.toThrow()
    expect(client.getStatus()).toBe("open")
  })
})

describe("render-phase acquire leak guard", () => {
  it("sweeps a record that was acquired but never retained", () => {
    const client = new FunctionsClient({ url: "ws://x/ws" })
    client.connect()
    MockWS.instances[0]!.open()
    client.acquireValue("orphan:query", {}) // acquired in a since-discarded render
    vi.advanceTimersByTime(1000)
    // Re-acquiring builds a fresh record and subscribes cleanly once retained.
    const { key } = client.acquireValue("orphan:query", {})
    client.retain(key)
    vi.advanceTimersByTime(1000)
    expect(MockWS.instances[0]!.sent.filter((f) => f.type === "subscribe")).toHaveLength(1)
  })
})
