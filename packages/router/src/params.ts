/**
 * Path → params, at the type level and the value level. The path string carried
 * by `defineRoute({ path })` is the single source of truth: `"/posts/:postId"`
 * yields `{ postId: string }` with no schema and no magic import.
 */

type Segments<P extends string> = P extends `${infer A}/${infer B}` ? A | Segments<B> : P
type ParamName<S extends string> = S extends `:${infer N}` ? N : S extends `*${infer N}` ? N : never

/** Extract the params object type from a path pattern. `/posts/:postId` → `{ postId: string }`. */
export type PathParams<P extends string> = { [S in Segments<P> as ParamName<S>]: string }

export interface CompiledPattern {
  readonly pattern: string
  readonly regex: RegExp
  readonly keys: ReadonlyArray<string>
  /** Specificity score: static segments rank above dynamic, dynamic above catch-all. */
  readonly score: number
}

/** Compile a `:param` / `*splat` path pattern into a matcher. */
export function compilePattern(pattern: string): CompiledPattern {
  const keys: string[] = []
  let score = 0
  const segments = pattern.split("/").filter((s) => s.length > 0)
  let re = "^"
  for (const seg of segments) {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1))
      re += "/([^/]+)"
      score += 2
    } else if (seg.startsWith("*")) {
      keys.push(seg.slice(1))
      re += "/(.*)"
      score += 1
    } else {
      re += "/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      score += 3
    }
  }
  if (segments.length === 0) re += "/?"
  re += "/?$"
  return { pattern, regex: new RegExp(re), keys, score }
}

/** Match a pathname against a compiled pattern, returning the params or null. */
export function matchPattern(compiled: CompiledPattern, pathname: string): Record<string, string> | null {
  const m = compiled.regex.exec(pathname)
  if (!m) return null
  const params: Record<string, string> = {}
  compiled.keys.forEach((key, i) => {
    params[key] = decodeURIComponent(m[i + 1] ?? "")
  })
  return params
}

/** Substitute params into a pattern to build a concrete href (`/posts/:id` → `/posts/7`). */
export function buildHref(pattern: string, params: Record<string, string | number> = {}): string {
  return (
    "/" +
    pattern
      .split("/")
      .filter((s) => s.length > 0)
      .map((seg) => {
        if (seg.startsWith(":") || seg.startsWith("*")) {
          const key = seg.slice(1)
          if (params[key] === undefined) throw new Error(`buildHref: missing param "${key}" for ${pattern}`)
          return encodeURIComponent(String(params[key]))
        }
        return seg
      })
      .join("/")
  )
}

/**
 * Parse a query string into a typed search object using a defaults object: the
 * default value's type drives coercion (a number default → parse as number) and
 * provides the fallback. No schema required for the common case.
 */
export function parseSearch<S extends Record<string, unknown>>(defaults: S, queryString: string): S {
  const params = new URLSearchParams(queryString)
  const out: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(defaults)) {
    const raw = params.get(key)
    if (raw === null) continue
    const def = defaults[key]
    if (typeof def === "number") out[key] = Number(raw)
    else if (typeof def === "boolean") out[key] = raw === "true"
    else out[key] = raw
  }
  return out as S
}

/** Serialize a search object back to a query string, omitting values equal to the defaults. */
export function serializeSearch(defaults: Record<string, unknown>, search: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue
    if (defaults[key] === value) continue
    params.set(key, String(value))
  }
  const s = params.toString()
  return s ? `?${s}` : ""
}
