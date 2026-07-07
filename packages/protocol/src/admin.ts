import type { PaginationOpts } from "./pagination.js"
import type { QuerySpec } from "./query.js"
import type { OrderKey, Row, Scalar } from "./values.js"

/**
 * The admin/DB wire protocol: raw, un-named table operations a trusted
 * server-side client (`@rabbat/db`) sends to a partition's `/db` endpoint.
 *
 * This is a privileged surface — it bypasses the function layer's argument
 * validators and auth middleware (that is the point: a flexible client for code
 * that runs *outside* a rabbat function, e.g. an auth adapter). It is gated by a
 * service key and MUST never be exposed to the browser. Engine-level validation
 * (column kinds, finiteness, unique constraints, size caps) still applies to
 * every write.
 */

/** A single write in an atomic `mutate` batch. Mirrors the engine's mutation. */
export type DbWrite =
  | { readonly kind: "insert"; readonly table: string; readonly row: Row }
  | {
      readonly kind: "patch"
      readonly table: string
      readonly pk: Scalar
      readonly fields: Record<string, Scalar>
    }
  | { readonly kind: "delete"; readonly table: string; readonly pk: Scalar }

/** A request to the partition `/db` endpoint. */
export type DbRequest =
  | { readonly op: "get"; readonly table: string; readonly pk: Scalar }
  | { readonly op: "query"; readonly spec: QuerySpec; readonly limit: number }
  | { readonly op: "paginate"; readonly spec: QuerySpec; readonly opts: PaginationOpts }
  | { readonly op: "mutate"; readonly writes: ReadonlyArray<DbWrite> }

/** A paginated read result over the admin protocol. */
export interface DbPage {
  readonly rows: ReadonlyArray<Row>
  readonly pk: string
  readonly order: ReadonlyArray<OrderKey>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly total: number
}

/** The successful response for each op (wrapped in `{ ok: true, value }`). */
export type DbResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/** The header carrying the service key (server-to-server auth). */
export const SERVICE_KEY_HEADER = "X-Rabbat-Service-Key"
