import { Data } from "effect"

/** A failure reading or writing the blob store / segments. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A query referenced an unknown table/column, or was otherwise malformed. */
export class QueryError extends Data.TaggedError("QueryError")<{
  readonly message: string
}> {}

/**
 * An optimistic-concurrency conflict: a row in the mutation's read-set was
 * written by a newer commit than the snapshot it read. The caller should retry.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string
}> {}

/** A uniqueness constraint was violated by an insert/patch. */
export class UniqueViolation extends Data.TaggedError("UniqueViolation")<{
  readonly table: string
  readonly index: string
}> {}
