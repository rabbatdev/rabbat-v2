import { describe, expect, it } from "vitest"
import {
  buildHref,
  compilePattern,
  createRouter,
  matchPattern,
  memoryHistory,
  parseSearch,
  type LoaderContext,
  type PathParams,
  type RouterManifest,
} from "@rabbat/router"

// ── Type-level: params inferred from the path string, no schema ──────────────
type P = PathParams<"/channels/:channelId/messages/:messageId">
const _typecheck: P = { channelId: "a", messageId: "b" }
void _typecheck

describe("path patterns", () => {
  it("matches and extracts params", () => {
    const c = compilePattern("/channels/:channelId")
    expect(matchPattern(c, "/channels/general")).toEqual({ channelId: "general" })
    expect(matchPattern(c, "/channels/general/extra")).toBeNull()
    expect(matchPattern(c, "/other")).toBeNull()
  })

  it("ranks static segments above dynamic", () => {
    expect(compilePattern("/about").score).toBeGreaterThan(compilePattern("/:slug").score)
  })

  it("builds hrefs from params", () => {
    expect(buildHref("/channels/:channelId", { channelId: "general" })).toBe("/channels/general")
    expect(() => buildHref("/channels/:channelId", {})).toThrow()
  })

  it("parses search using a defaults object (type-driven coercion)", () => {
    const out = parseSearch({ page: 1, q: "" }, "?page=3&q=hi")
    expect(out).toEqual({ page: 3, q: "hi" })
    expect(parseSearch({ page: 1 }, "")).toEqual({ page: 1 }) // fallback to default
  })
})

describe("navigation store", () => {
  const stubContext: LoaderContext = {
    preload: async () => undefined as never,
    runQuery: async () => undefined as never,
    runMutation: async () => undefined as never,
    identity: null,
  }

  const manifest: RouterManifest = {
    layouts: [],
    routes: [
      {
        pattern: "/channels/:channelId",
        ssr: true,
        layouts: [],
        load: async () => ({ default: "PageComponent" }),
        loadRoute: async () => ({
          route: {
            path: "/channels/:channelId",
            loader: async ({ params }) => ({ channel: params.channelId.toUpperCase() }),
            meta: ({ data }) => ({ title: `#${data.channel}` }),
          },
        }),
      },
    ],
  }

  it("matches, runs the loader, and exposes typed data + meta", async () => {
    const router = createRouter({
      manifest,
      history: memoryHistory("/"),
      makeContext: () => ({ context: stubContext, collectPreloads: () => ({}) }),
    })
    await router.navigate("/channels/general")
    const s = router.getSnapshot()
    expect(s.match?.params).toEqual({ channelId: "general" })
    expect(s.loaderData.route).toEqual({ channel: "GENERAL" })
    expect(s.meta.title).toBe("#GENERAL")
    expect(s.status).toBe("idle")
  })

  it("reports no match for unknown paths", async () => {
    const router = createRouter({
      manifest,
      history: memoryHistory("/"),
      makeContext: () => ({ context: stubContext, collectPreloads: () => ({}) }),
    })
    await router.navigate("/nope")
    expect(router.getSnapshot().match).toBeNull()
  })
})
