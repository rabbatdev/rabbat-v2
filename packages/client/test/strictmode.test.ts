import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FunctionsClient } from "@rabbat/client"

/** Minimal WebSocket stand-in that records sent frames and lets tests drive events. */
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
}

describe("FunctionsClient subscription lifecycle (React StrictMode)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWS.instances = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = MockWS as unknown
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = () => {
    const client = new FunctionsClient({ url: "ws://x/ws", reconnect: false })
    client.connect()
    const ws = MockWS.instances[0]!
    ws.open()
    return { client, ws }
  }

  it("survives a StrictMode remount (release → retain) without tearing down the subscription", () => {
    const { client, ws } = setup()
    const { store, key } = client.acquireValue<{ id: string }[]>("channels:list", {})

    client.retain(key) // mount
    client.release(key) // StrictMode cleanup
    client.retain(key) // StrictMode setup (synchronous)
    vi.advanceTimersByTime(1000) // past the release grace window

    // No unsubscribe should have been sent: the subscription was reclaimed.
    expect(ws.sent.filter((m) => m.type === "unsubscribe")).toEqual([])
    const subscribe = ws.sent.find((m) => m.type === "subscribe")!
    expect(subscribe).toBeDefined()

    // And it still delivers live data into the same store.
    ws.message({ type: "subscribed", sub: subscribe.sub, paginated: false })
    ws.message({ type: "value", sub: subscribe.sub, value: [{ id: "general" }], watermark: 1 })
    expect(store.getSnapshot().data).toEqual([{ id: "general" }])
  })

  it("a genuine release (no re-retain) tears the subscription down after the grace window", () => {
    const { client, ws } = setup()
    const { key } = client.acquireValue("channels:list", {})
    client.retain(key)
    client.release(key)

    expect(ws.sent.some((m) => m.type === "unsubscribe")).toBe(false) // deferred
    vi.advanceTimersByTime(1000)
    expect(ws.sent.some((m) => m.type === "unsubscribe")).toBe(true) // torn down
  })

  it("subscribes exactly once across a retain/release/retain cycle", () => {
    const { client, ws } = setup()
    const { key } = client.acquireValue("channels:list", {})
    client.retain(key)
    client.release(key)
    client.retain(key)
    vi.advanceTimersByTime(1000)
    expect(ws.sent.filter((m) => m.type === "subscribe")).toHaveLength(1)
  })
})
