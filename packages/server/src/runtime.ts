import { Effect } from "effect"
import type { Filter, OrderKey, PaginationOpts, Row, Scalar } from "@rabbat/protocol"
import { type SchemaInfo, tableInfo } from "@rabbat/schema"
import type { EngineApi, Mutation, RowChange } from "@rabbat/engine"
import {
  type AnyRegistered,
  type DbExecutor,
  type Identity,
  type Paginated,
  type Scheduler,
  makeReader,
  makeWriter,
  validateArgs,
} from "@rabbat/functions"

/** A discovered function with its fully-qualified name. */
export interface RegistryEntry {
  readonly name: string
  readonly fn: AnyRegistered
}

/** `modules[moduleName][exportName] = registeredFunction`. */
export type Modules = Record<string, Record<string, unknown>>

export interface RuntimeConfig {
  readonly schema: SchemaInfo
  readonly modules: Modules
  readonly auth?: (token: string | null) => Identity | null | Promise<Identity | null>
}

/** The shape a paginated query read — captured so the DO can re-run and diff it. */
export interface CapturedPage {
  readonly spec: import("@rabbat/protocol").QuerySpec
  readonly order: ReadonlyArray<OrderKey>
  readonly pk: string
  readonly page: Paginated<Row>
}

export interface QueryResult {
  readonly paginated: boolean
  /** For value queries: the handler's return value. */
  readonly value: unknown
  /** For paginated queries: the captured window. */
  readonly captured?: CapturedPage
  /** Tables + equality bindings the query read, for reactive routing. */
  readonly deps: ReadonlyArray<{ table: string; filters: ReadonlyArray<Filter> }>
}

export interface MutationResult {
  readonly value: unknown
  readonly lsn: number
  readonly changes: ReadonlyArray<RowChange>
  readonly scheduled: ReadonlyArray<ScheduledCall>
}

export interface ScheduledCall {
  readonly at: number
  readonly name: string
  readonly args: Record<string, unknown>
}

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

/**
 * The functions runtime: a registry over the app's modules plus the machinery to
 * run a query (reactive, dependency-capturing), a mutation (buffered into one
 * atomic engine commit), or an action (arbitrary I/O via `runQuery`/`runMutation`).
 * It bridges the Promise-based handler world to the Effect-based engine.
 */
export class Runtime {
  readonly registry = new Map<string, AnyRegistered>()

  constructor(
    private readonly config: RuntimeConfig,
    private readonly engine: EngineApi,
  ) {
    for (const [moduleName, mod] of Object.entries(config.modules)) {
      for (const [exportName, value] of Object.entries(mod)) {
        if (isRegistered(value)) this.registry.set(`${moduleName}:${exportName}`, value)
      }
    }
  }

  get lsn(): number {
    return this.engine.lsn()
  }

  pkOf(table: string): string {
    return tableInfo(this.config.schema, table).pk
  }

  resolveIdentity(token: string | null): Promise<Identity | null> {
    return Promise.resolve(this.config.auth ? this.config.auth(token) : null)
  }

  /**
   * Resolve a function by name. `fromClient` requests (WebSocket / HTTP) may not
   * invoke `internal*` functions — those are server-only (scheduler, action
   * `ctx.run*`), and app authors rely on that to skip auth checks inside them.
   */
  private require(name: string, fromClient: boolean): AnyRegistered {
    const fn = this.registry.get(name)
    if (!fn) throw new Error(`unknown function: ${name}`)
    if (fromClient && fn.internal) throw new Error(`unknown function: ${name}`)
    return fn
  }

  private baseCtx(identity: Identity | null): { identity: Identity | null; requireIdentity: () => Identity } {
    return {
      identity,
      requireIdentity: () => {
        if (!identity) throw new Error("Authentication required")
        return identity
      },
    }
  }

  private readerExecutor(recorder: Recorder, overlay?: WriteOverlay): DbExecutor {
    const engine = this.engine
    const pkOf = (t: string) => this.pkOf(t)
    return {
      collect: async (spec, limit) => {
        recorder.reads.push({ table: spec.table, filters: spec.filters })
        return run(engine.collect(spec, limit))
      },
      paginate: async (spec, opts) => {
        const out = await run(engine.paginate(spec, opts))
        const result: Paginated<Row> = {
          __paginated: true,
          page: out.rows,
          total: out.total,
          hasOlder: out.hasOlder,
          hasNewer: out.hasNewer,
          pk: out.pk,
        }
        recorder.page = { spec, order: out.order, pk: out.pk, page: result }
        recorder.reads.push({ table: spec.table, filters: spec.filters })
        return result
      },
      get: async (table, id) => {
        recorder.reads.push({ table, filters: [{ column: pkOf(table), op: "=", value: id }] })
        // Read-your-writes for point reads: a mutation's own buffered
        // insert/patch/delete is visible to a subsequent get() in the same handler.
        const pending = overlay?.get(table, id)
        if (pending !== undefined) return pending
        return run(engine.get(table, id))
      },
      insert: () => Promise.reject(new Error("cannot write from a query")),
      patch: () => Promise.reject(new Error("cannot write from a query")),
      remove: () => Promise.reject(new Error("cannot write from a query")),
    }
  }

  /** Run a query, capturing its reactive dependencies / paginated window. */
  async runQuery(
    name: string,
    rawArgs: Record<string, unknown>,
    identity: Identity | null,
    fromClient = true,
  ): Promise<QueryResult> {
    const fn = this.require(name, fromClient)
    if (fn.__kind !== "query") throw new Error(`${name} is not a query`)
    const args = validateArgs(fn.argsValidator, rawArgs)
    const recorder: Recorder = { reads: [] }
    const ctx = { ...this.baseCtx(identity), db: makeReader(this.readerExecutor(recorder)) }
    for (const mw of fn.middleware) await mw(ctx)
    const value = await fn.handler(ctx, args)
    return {
      paginated: !!recorder.page,
      value,
      captured: recorder.page,
      deps: recorder.reads,
    }
  }

  /** Run a mutation: handler writes are buffered into one atomic engine commit. */
  async runMutation(
    name: string,
    rawArgs: Record<string, unknown>,
    identity: Identity | null,
    fromClient = true,
  ): Promise<MutationResult> {
    const fn = this.require(name, fromClient)
    if (fn.__kind !== "mutation") throw new Error(`${name} is not a mutation`)
    const args = validateArgs(fn.argsValidator, rawArgs)
    const buffer: Mutation[] = []
    const scheduled: ScheduledCall[] = []
    const recorder: Recorder = { reads: [] }
    const overlay = new WriteOverlay((t) => this.pkOf(t))
    const exec = this.writerExecutor(recorder, buffer, overlay)
    const ctx = {
      ...this.baseCtx(identity),
      db: makeWriter(exec),
      scheduler: this.scheduler(scheduled),
    }
    for (const mw of fn.middleware) await mw(ctx)
    const value = await fn.handler(ctx, args)
    const { lsn, changes } = await run(this.engine.mutate(buffer))
    return { value, lsn, changes, scheduled }
  }

  /**
   * Dispatch a scheduled job (from an alarm) by its registered kind. A scheduled
   * mutation commits changes; a scheduled action runs with no transaction. These
   * are server-trusted (they may target internal functions).
   */
  async runScheduled(name: string, args: Record<string, unknown>): Promise<MutationResult> {
    const fn = this.registry.get(name)
    if (!fn) throw new Error(`unknown function: ${name}`)
    if (fn.__kind === "mutation") return this.runMutation(name, args, null, false)
    if (fn.__kind === "action") {
      const value = await this.runAction(name, args, null, false)
      return { value, lsn: this.engine.lsn(), changes: [], scheduled: [] }
    }
    throw new Error(`${name} is not schedulable`)
  }

  /** Run an action: no transaction; DB access only via runQuery/runMutation. */
  async runAction(
    name: string,
    rawArgs: Record<string, unknown>,
    identity: Identity | null,
    fromClient = true,
  ): Promise<unknown> {
    const fn = this.require(name, fromClient)
    if (fn.__kind !== "action") throw new Error(`${name} is not an action`)
    const args = validateArgs(fn.argsValidator, rawArgs)
    const scheduled: ScheduledCall[] = []
    // ctx.run* are server-trusted: an action may orchestrate internal functions.
    const ctx = {
      ...this.baseCtx(identity),
      scheduler: this.scheduler(scheduled),
      runQuery: (ref: { name: string }, a: Record<string, unknown>) =>
        this.runQuery(ref.name, a, identity, false).then((r) => r.value),
      runMutation: (ref: { name: string }, a: Record<string, unknown>) =>
        this.runMutation(ref.name, a, identity, false).then((r) => r.value),
      runAction: (ref: { name: string }, a: Record<string, unknown>) =>
        this.runAction(ref.name, a, identity, false),
    }
    for (const mw of fn.middleware) await mw(ctx)
    return fn.handler(ctx, args)
  }

  private writerExecutor(recorder: Recorder, buffer: Mutation[], overlay: WriteOverlay): DbExecutor {
    const reader = this.readerExecutor(recorder, overlay)
    const engine = this.engine
    return {
      ...reader,
      insert: async (table, row) => {
        buffer.push({ kind: "insert", table, row })
        overlay.set(table, row[this.pkOf(table)] ?? null, row)
      },
      patch: async (table, id, fields) => {
        buffer.push({ kind: "patch", table, pk: id, fields })
        // Merge onto the current (buffered or committed) row so a later get()
        // reflects the patch.
        const current = overlay.has(table, id) ? overlay.get(table, id) : await run(engine.get(table, id))
        if (current) {
          const next: Row = { ...current }
          for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v as Row[string]
          overlay.set(table, id, next)
        }
      },
      remove: async (table, id) => {
        buffer.push({ kind: "delete", table, pk: id })
        overlay.set(table, id, null)
      },
    }
  }

  private scheduler(out: ScheduledCall[]): Scheduler {
    return {
      runAfter: (delayMs, ref, args) =>
        out.push({ at: nowMs() + delayMs, name: (ref as { name: string }).name, args: args as Record<string, unknown> }),
      runAt: (timestampMs, ref, args) =>
        out.push({ at: timestampMs, name: (ref as { name: string }).name, args: args as Record<string, unknown> }),
    }
  }
}

interface Recorder {
  reads: Array<{ table: string; filters: ReadonlyArray<Filter> }>
  page?: CapturedPage
}

/**
 * A mutation's own buffered writes, keyed by (table, pk), so a point `get()`
 * later in the same handler observes read-your-writes. `null` marks a deleted
 * row. (Range reads within a mutation still observe committed state.)
 */
class WriteOverlay {
  private readonly rows = new Map<string, Row | null>()
  constructor(private readonly pkOf: (table: string) => string) {}
  private key(table: string, pk: Scalar): string {
    return `${table} ${typeof pk} ${String(pk)}`
  }
  has(table: string, pk: Scalar): boolean {
    return this.rows.has(this.key(table, pk))
  }
  get(table: string, pk: Scalar): Row | null | undefined {
    return this.rows.get(this.key(table, pk))
  }
  set(table: string, pk: Scalar, row: Row | null): void {
    this.rows.set(this.key(table, pk), row)
  }
}

function isRegistered(v: unknown): v is AnyRegistered {
  return (
    typeof v === "object" &&
    v !== null &&
    "__kind" in v &&
    ((v as { __kind: unknown }).__kind === "query" ||
      (v as { __kind: unknown }).__kind === "mutation" ||
      (v as { __kind: unknown }).__kind === "action")
  )
}

function nowMs(): number {
  return Date.now()
}

export type { Scalar, PaginationOpts }
