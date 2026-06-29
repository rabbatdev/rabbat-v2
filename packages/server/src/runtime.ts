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

  private require(name: string): AnyRegistered {
    const fn = this.registry.get(name)
    if (!fn) throw new Error(`unknown function: ${name}`)
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

  private readerExecutor(recorder: Recorder): DbExecutor {
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
        return run(engine.get(table, id))
      },
      insert: () => Promise.reject(new Error("cannot write from a query")),
      patch: () => Promise.reject(new Error("cannot write from a query")),
      remove: () => Promise.reject(new Error("cannot write from a query")),
    }
  }

  /** Run a query, capturing its reactive dependencies / paginated window. */
  async runQuery(name: string, rawArgs: Record<string, unknown>, identity: Identity | null): Promise<QueryResult> {
    const fn = this.require(name)
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
  ): Promise<MutationResult> {
    const fn = this.require(name)
    if (fn.__kind !== "mutation") throw new Error(`${name} is not a mutation`)
    const args = validateArgs(fn.argsValidator, rawArgs)
    const buffer: Mutation[] = []
    const scheduled: ScheduledCall[] = []
    const recorder: Recorder = { reads: [] }
    const exec = this.writerExecutor(recorder, buffer)
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

  /** Run an action: no transaction; DB access only via runQuery/runMutation. */
  async runAction(name: string, rawArgs: Record<string, unknown>, identity: Identity | null): Promise<unknown> {
    const fn = this.require(name)
    if (fn.__kind !== "action") throw new Error(`${name} is not an action`)
    const args = validateArgs(fn.argsValidator, rawArgs)
    const scheduled: ScheduledCall[] = []
    const ctx = {
      ...this.baseCtx(identity),
      scheduler: this.scheduler(scheduled),
      runQuery: (ref: { name: string }, a: Record<string, unknown>) =>
        this.runQuery(ref.name, a, identity).then((r) => r.value),
      runMutation: (ref: { name: string }, a: Record<string, unknown>) =>
        this.runMutation(ref.name, a, identity).then((r) => r.value),
      runAction: (ref: { name: string }, a: Record<string, unknown>) => this.runAction(ref.name, a, identity),
    }
    for (const mw of fn.middleware) await mw(ctx)
    return fn.handler(ctx, args)
  }

  private writerExecutor(recorder: Recorder, buffer: Mutation[]): DbExecutor {
    const reader = this.readerExecutor(recorder)
    return {
      ...reader,
      insert: async (table, row) => {
        buffer.push({ kind: "insert", table, row })
      },
      patch: async (table, id, fields) => {
        buffer.push({ kind: "patch", table, pk: id, fields })
      },
      remove: async (table, id) => {
        buffer.push({ kind: "delete", table, pk: id })
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
