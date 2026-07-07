// rabbat/env → a small typed-env helper (t3-env-style) for a rabbat-v2 app.
//
// `defineEnv({ shared, server, client?, derive? })` validates `process.env`
// against zod schemas and folds in computed values. Server vars never reach the
// browser bundle (they're read from `process.env`, which Vite doesn't inline).

import { z } from "zod"

export { z }

type Shape = Record<string, z.ZodTypeAny>

export interface EnvDef<S extends Shape, V extends Shape, D> {
  /** Available on both server and client. */
  shared?: S
  /** Server-only. */
  server?: V
  /** Fold validated env into computed values. */
  derive?: (parsed: z.infer<z.ZodObject<S & V>>) => D
}

/**
 * Validate + derive the environment. Returns the validated shared+server vars
 * merged with whatever `derive` computes (derive keys win on conflict).
 */
export function defineEnv<S extends Shape, V extends Shape, D extends Record<string, unknown>>(
  def: EnvDef<S, V, D>,
): z.infer<z.ZodObject<S & V>> & D {
  const shape = { ...(def.shared ?? {}), ...(def.server ?? {}) } as S & V
  const schema = z.object(shape)
  const source = typeof process !== "undefined" ? process.env : {}
  const parsed = schema.parse(source) as z.infer<z.ZodObject<S & V>>
  const derived = def.derive ? def.derive(parsed) : ({} as D)
  return { ...parsed, ...derived }
}

/** A validator for a rabbat service token (a non-empty string). */
export function rabbatToken(): z.ZodString {
  return z.string().min(1)
}
