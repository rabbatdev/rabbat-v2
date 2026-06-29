import type { Anchor, PaginationOpts } from "@rabbat/protocol"

/**
 * Runtime argument validators. Args are validated at runtime (`v.string()`, …)
 * and inferred at compile time, so handler args and `ctx.db` calls are fully
 * typed. The browser only ever calls named functions, so this is the single
 * trust boundary for argument shapes.
 */
export interface Validator<T, Optional extends boolean = false> {
  readonly kind: string
  readonly isOptional: Optional
  parse(value: unknown, path: string): T
  readonly _type?: T
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

export type Infer<V> = V extends Validator<infer T, boolean> ? T : never
export type PropValidators = Record<string, Validator<unknown, boolean>>

type RequiredKeys<P extends PropValidators> = {
  [K in keyof P]: P[K] extends Validator<unknown, true> ? never : K
}[keyof P]
type OptionalKeys<P extends PropValidators> = {
  [K in keyof P]: P[K] extends Validator<unknown, true> ? K : never
}[keyof P]

type Expand<T> = { [K in keyof T]: T[K] } & {}

export type ObjectType<P extends PropValidators> = Expand<
  { [K in RequiredKeys<P>]: Infer<P[K]> } & { [K in OptionalKeys<P>]?: Infer<P[K]> }
>

function make<T>(kind: string, parse: (value: unknown, path: string) => T): Validator<T, false> {
  return { kind, isOptional: false, parse }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const v = {
  string: () =>
    make<string>("string", (val, path) => {
      if (typeof val !== "string") throw new ValidationError(`${path}: expected string`)
      return val
    }),
  number: () =>
    make<number>("number", (val, path) => {
      if (typeof val !== "number" || Number.isNaN(val)) throw new ValidationError(`${path}: expected number`)
      return val
    }),
  boolean: () =>
    make<boolean>("boolean", (val, path) => {
      if (typeof val !== "boolean") throw new ValidationError(`${path}: expected boolean`)
      return val
    }),
  /** Semantic alias for a string id. */
  id: () =>
    make<string>("id", (val, path) => {
      if (typeof val !== "string") throw new ValidationError(`${path}: expected id`)
      return val
    }),
  any: () => make<unknown>("any", (val) => val),
  literal: <const L extends string | number | boolean>(lit: L) =>
    make<L>("literal", (val, path) => {
      if (val !== lit) throw new ValidationError(`${path}: expected ${JSON.stringify(lit)}`)
      return lit
    }),
  array: <V extends Validator<unknown, boolean>>(inner: V) =>
    make<Array<Infer<V>>>("array", (val, path) => {
      if (!Array.isArray(val)) throw new ValidationError(`${path}: expected array`)
      return val.map((x, i) => inner.parse(x, `${path}[${i}]`)) as Array<Infer<V>>
    }),
  object: <P extends PropValidators>(shape: P) =>
    make<ObjectType<P>>("object", (val, path) => parseObject(shape, val, path)),
  optional: <V extends Validator<unknown, boolean>>(inner: V): Validator<Infer<V> | undefined, true> => ({
    kind: `optional<${inner.kind}>`,
    isOptional: true,
    parse: (val, path) => (val === undefined ? undefined : (inner.parse(val, path) as Infer<V>)),
  }),
}

export function parseObject<P extends PropValidators>(
  shape: P,
  value: unknown,
  path: string,
): ObjectType<P> {
  if (!isPlainObject(value)) throw new ValidationError(`${path}: expected object`)
  const out: Record<string, unknown> = {}
  for (const [key, validator] of Object.entries(shape)) {
    const present = key in value
    if (!present && !validator.isOptional) throw new ValidationError(`${path}.${key}: required`)
    if (present) out[key] = validator.parse(value[key], `${path}.${key}`)
  }
  return out as ObjectType<P>
}

/** Validate raw call args against a function's declared validators. */
export function validateArgs<P extends PropValidators>(shape: P, args: unknown): ObjectType<P> {
  return parseObject(shape, args ?? {}, "args")
}

const isAnchor = (a: unknown): a is Anchor => {
  if (!isPlainObject(a)) return false
  switch (a.kind) {
    case "latest":
    case "earliest":
      return true
    case "cursor":
      return typeof a.cursor === "string"
    case "key":
      return ["string", "number", "boolean"].includes(typeof a.key)
    default:
      return false
  }
}

/**
 * The validator for a live, bi-directional pagination window. Declare it in a
 * paginated query's args; the client supplies it and grows it on scroll.
 */
export const paginationOpts: Validator<PaginationOpts, false> = make<PaginationOpts>(
  "paginationOpts",
  (val, path) => {
    if (!isPlainObject(val)) throw new ValidationError(`${path}: expected pagination opts`)
    const { before, after, anchor } = val
    if (typeof before !== "number" || typeof after !== "number")
      throw new ValidationError(`${path}: before/after must be numbers`)
    if (!isAnchor(anchor)) throw new ValidationError(`${path}: invalid anchor`)
    return { before, after, anchor }
  },
)
