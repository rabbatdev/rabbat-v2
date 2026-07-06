import type { DataModel } from "@rabbat/schema"
import type { DatabaseReader, DatabaseWriter, Paginated } from "./db.js"
import type { ObjectType, PropValidators } from "./values.js"

export interface Identity {
  readonly subject: string
  readonly [key: string]: unknown
}

export interface GenericCtx {
  readonly identity: Identity | null
  requireIdentity(): Identity
}

export interface QueryCtx<DM extends DataModel> extends GenericCtx {
  readonly db: DatabaseReader<DM>
}

export interface MutationCtx<DM extends DataModel> extends GenericCtx {
  readonly db: DatabaseWriter<DM>
  readonly scheduler: Scheduler
}

export interface ActionCtx<_DM extends DataModel> extends GenericCtx {
  runQuery<Ref extends FunctionReference<"query", any, any>>(ref: Ref, args: ArgsOf<Ref>): Promise<ReturnOf<Ref>>
  runMutation<Ref extends FunctionReference<"mutation", any, any>>(ref: Ref, args: ArgsOf<Ref>): Promise<ReturnOf<Ref>>
  runAction<Ref extends FunctionReference<"action", any, any>>(ref: Ref, args: ArgsOf<Ref>): Promise<ReturnOf<Ref>>
  readonly scheduler: Scheduler
}

export interface Scheduler {
  runAfter<Ref extends FunctionReference<"mutation" | "action", any, any>>(
    delayMs: number,
    ref: Ref,
    args: ArgsOf<Ref>,
  ): void
  runAt<Ref extends FunctionReference<"mutation" | "action", any, any>>(
    timestampMs: number,
    ref: Ref,
    args: ArgsOf<Ref>,
  ): void
}

export type Middleware<Ctx> = (ctx: Ctx) => void | Promise<void>

// ── Registered functions ──────────────────────────────────────────────────

interface Registered<Kind extends string, Args, Return> {
  readonly __kind: Kind
  readonly argsValidator: PropValidators
  readonly handler: (ctx: any, args: Args) => Promise<Return> | Return
  readonly middleware: ReadonlyArray<Middleware<any>>
  readonly internal: boolean
}
export type RegisteredQuery<Args, Return> = Registered<"query", Args, Return>
export type RegisteredMutation<Args, Return> = Registered<"mutation", Args, Return>
export type RegisteredAction<Args, Return> = Registered<"action", Args, Return>
export type AnyRegistered = Registered<"query" | "mutation" | "action", any, any>

// ── Function references (browser-facing, handler code erased) ───────────────

export interface FunctionReference<Kind extends "query" | "mutation" | "action", Args, Return> {
  readonly __isFunctionReference: true
  readonly __kind: Kind
  readonly __args: Args
  readonly __return: Return
  readonly name: string
}

export type RefOf<F> =
  F extends RegisteredQuery<infer A, infer R>
    ? FunctionReference<"query", A, R>
    : F extends RegisteredMutation<infer A, infer R>
      ? FunctionReference<"mutation", A, R>
      : F extends RegisteredAction<infer A, infer R>
        ? FunctionReference<"action", A, R>
        : never

export type ArgsOf<F> = F extends FunctionReference<any, infer A, any> ? A : never
export type ReturnOf<F> = F extends FunctionReference<any, any, infer R> ? R : never
export type FunctionArgs<F> = ArgsOf<F>
export type FunctionReturns<F> = ReturnOf<F>
export type PaginatedRow<F> = ReturnOf<F> extends Paginated<infer R> ? R : never

// ── Builders ────────────────────────────────────────────────────────────────

export interface QueryDef<DM extends DataModel, V extends PropValidators, R> {
  args: V
  handler: (ctx: QueryCtx<DM>, args: ObjectType<V>) => R | Promise<R>
  middleware?: ReadonlyArray<Middleware<QueryCtx<DM>>>
}
export interface MutationDef<DM extends DataModel, V extends PropValidators, R> {
  args: V
  handler: (ctx: MutationCtx<DM>, args: ObjectType<V>) => R | Promise<R>
  middleware?: ReadonlyArray<Middleware<MutationCtx<DM>>>
}
export interface ActionDef<DM extends DataModel, V extends PropValidators, R> {
  args: V
  handler: (ctx: ActionCtx<DM>, args: ObjectType<V>) => R | Promise<R>
  middleware?: ReadonlyArray<Middleware<ActionCtx<DM>>>
}

export interface FunctionBuilders<DM extends DataModel> {
  query<V extends PropValidators, R>(def: QueryDef<DM, V, R>): RegisteredQuery<ObjectType<V>, Awaited<R>>
  mutation<V extends PropValidators, R>(def: MutationDef<DM, V, R>): RegisteredMutation<ObjectType<V>, Awaited<R>>
  action<V extends PropValidators, R>(def: ActionDef<DM, V, R>): RegisteredAction<ObjectType<V>, Awaited<R>>
  internalQuery<V extends PropValidators, R>(def: QueryDef<DM, V, R>): RegisteredQuery<ObjectType<V>, Awaited<R>>
  internalMutation<V extends PropValidators, R>(def: MutationDef<DM, V, R>): RegisteredMutation<ObjectType<V>, Awaited<R>>
  internalAction<V extends PropValidators, R>(def: ActionDef<DM, V, R>): RegisteredAction<ObjectType<V>, Awaited<R>>
}

function register<Kind extends "query" | "mutation" | "action">(kind: Kind, internal: boolean) {
  return (def: { args: PropValidators; handler: any; middleware?: ReadonlyArray<Middleware<any>> }) => ({
    __kind: kind,
    argsValidator: def.args,
    handler: def.handler,
    middleware: def.middleware ?? [],
    internal,
  })
}

export function defineFunctions<DM extends DataModel>(): FunctionBuilders<DM> {
  return {
    query: register("query", false) as FunctionBuilders<DM>["query"],
    mutation: register("mutation", false) as FunctionBuilders<DM>["mutation"],
    action: register("action", false) as FunctionBuilders<DM>["action"],
    internalQuery: register("query", true) as FunctionBuilders<DM>["internalQuery"],
    internalMutation: register("mutation", true) as FunctionBuilders<DM>["internalMutation"],
    internalAction: register("action", true) as FunctionBuilders<DM>["internalAction"],
  }
}

// ── Auth/middleware composition (Convex-helpers style) ──────────────────────

export interface CustomizerOutput<ExtraCtx extends object, AddArgs extends object> {
  ctx: ExtraCtx
  args: AddArgs
}

export interface Customizer<BaseCtx, ModArgs extends PropValidators, ExtraCtx extends object, AddArgs extends object> {
  args?: ModArgs
  input: (
    ctx: BaseCtx,
    args: ObjectType<ModArgs>,
  ) => CustomizerOutput<ExtraCtx, AddArgs> | Promise<CustomizerOutput<ExtraCtx, AddArgs>>
}

const makeCustom =
  <BaseCtx, ModArgs extends PropValidators, ExtraCtx extends object, AddArgs extends object>(
    kind: "query" | "mutation" | "action",
    customizer: Customizer<BaseCtx, ModArgs, ExtraCtx, AddArgs>,
  ) =>
  <V extends PropValidators, R>(def: {
    args: V
    handler: (ctx: BaseCtx & ExtraCtx, args: ObjectType<V> & AddArgs) => R | Promise<R>
    middleware?: ReadonlyArray<Middleware<BaseCtx>>
    /** Mark the resulting custom function server-only (not client-callable). */
    internal?: boolean
  }): Registered<typeof kind, ObjectType<ModArgs> & ObjectType<V>, Awaited<R>> => {
    const mergedArgs = { ...(customizer.args ?? {}), ...def.args } as PropValidators
    return {
      __kind: kind,
      argsValidator: mergedArgs,
      middleware: def.middleware ?? [],
      internal: def.internal ?? false,
      handler: async (ctx: BaseCtx, args: Record<string, unknown>): Promise<Awaited<R>> => {
        const out = await customizer.input(ctx, args as ObjectType<ModArgs>)
        const merged = { ...ctx, ...out.ctx } as BaseCtx & ExtraCtx
        return (await def.handler(merged, { ...args, ...out.args } as ObjectType<V> & AddArgs)) as Awaited<R>
      },
    }
  }

export function customQuery<DM extends DataModel, ModArgs extends PropValidators, ExtraCtx extends object, AddArgs extends object>(
  _base: FunctionBuilders<DM>["query"],
  customizer: Customizer<QueryCtx<DM>, ModArgs, ExtraCtx, AddArgs>,
) {
  return makeCustom<QueryCtx<DM>, ModArgs, ExtraCtx, AddArgs>("query", customizer)
}
export function customMutation<DM extends DataModel, ModArgs extends PropValidators, ExtraCtx extends object, AddArgs extends object>(
  _base: FunctionBuilders<DM>["mutation"],
  customizer: Customizer<MutationCtx<DM>, ModArgs, ExtraCtx, AddArgs>,
) {
  return makeCustom<MutationCtx<DM>, ModArgs, ExtraCtx, AddArgs>("mutation", customizer)
}
export function customAction<DM extends DataModel, ModArgs extends PropValidators, ExtraCtx extends object, AddArgs extends object>(
  _base: FunctionBuilders<DM>["action"],
  customizer: Customizer<ActionCtx<DM>, ModArgs, ExtraCtx, AddArgs>,
) {
  return makeCustom<ActionCtx<DM>, ModArgs, ExtraCtx, AddArgs>("action", customizer)
}
