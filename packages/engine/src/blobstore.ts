import { Context, Effect, Layer, Ref } from "effect"
import { StorageError } from "./errors.js"

export interface ByteRange {
  readonly offset: number
  readonly length: number
}

/**
 * The object-storage interface the engine writes the database onto. In
 * production this is backed by an R2 bucket; in tests by an in-memory map. R2's
 * range GET is what lets a segment read pull only the blocks a scan needs,
 * instead of the whole object — the basis of cheap, infinite storage.
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly get: (key: string, range?: ByteRange) => Effect.Effect<Uint8Array | null, StorageError>
    readonly put: (key: string, body: Uint8Array) => Effect.Effect<void, StorageError>
    readonly delete: (key: string) => Effect.Effect<void, StorageError>
    readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, StorageError>
  }
>()("rabbat/BlobStore") {}

/** An in-memory BlobStore for tests and local single-process dev. */
export const MemoryBlobStore = (
  seed?: ReadonlyArray<readonly [string, Uint8Array]>,
): Layer.Layer<BlobStore> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const map = yield* Ref.make(new Map<string, Uint8Array>(seed?.map(([k, v]) => [k, v])))
      return {
        get: (key, range) =>
          Ref.get(map).pipe(
            Effect.map((m) => {
              const v = m.get(key)
              if (!v) return null
              if (!range) return v
              return v.slice(range.offset, range.offset + range.length)
            }),
          ),
        put: (key, body) =>
          Ref.update(map, (m) => {
            const next = new Map(m)
            next.set(key, body.slice())
            return next
          }),
        delete: (key) =>
          Ref.update(map, (m) => {
            const next = new Map(m)
            next.delete(key)
            return next
          }),
        list: (prefix) =>
          Ref.get(map).pipe(
            Effect.map((m) => Array.from(m.keys()).filter((k) => k.startsWith(prefix)).sort()),
          ),
      }
    }),
  )

/**
 * A BlobStore backed by a Cloudflare R2 bucket. Pass the binding from the
 * Durable Object / Worker environment.
 */
export const R2BlobStore = (bucket: R2Bucket): Layer.Layer<BlobStore> =>
  Layer.succeed(BlobStore, {
    get: (key, range) =>
      Effect.tryPromise({
        try: async () => {
          const obj = range
            ? await bucket.get(key, { range: { offset: range.offset, length: range.length } })
            : await bucket.get(key)
          if (!obj) return null
          return new Uint8Array(await obj.arrayBuffer())
        },
        catch: (cause) => new StorageError({ message: `R2 get ${key} failed`, cause }),
      }),
    put: (key, body) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(key, body as unknown as ArrayBuffer)
        },
        catch: (cause) => new StorageError({ message: `R2 put ${key} failed`, cause }),
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: () => bucket.delete(key),
        catch: (cause) => new StorageError({ message: `R2 delete ${key} failed`, cause }),
      }),
    list: (prefix) =>
      Effect.tryPromise({
        try: async () => {
          const out: string[] = []
          let cursor: string | undefined
          do {
            const res = await bucket.list({ prefix, cursor })
            for (const o of res.objects) out.push(o.key)
            cursor = res.truncated ? res.cursor : undefined
          } while (cursor)
          return out
        },
        catch: (cause) => new StorageError({ message: `R2 list ${prefix} failed`, cause }),
      }),
  })
