// Schema-typed function builders. `ctx.db` is typed against the data model
// derived from `schema.ts` — no separate type-generation step.
//
// Rabbat functions are PUBLIC by default (the framework imposes no global auth
// gate). This app opts into auth Convex-style, by composing the base builders:
//   • `query` / `mutation` / `action`  → AUTHED: require a signed-in user and
//     inject a non-null `ctx.user`. The app default — most functions need a user.
//   • `publicQuery` / `publicMutation` → PUBLIC: no auth; read `ctx.identity`
//     (nullable) yourself. For unauthenticated reads (invite unfurls) and the
//     "current user's X" getters that return empty when signed out.

import { customAction, customMutation, customQuery, defineFunctions } from "rabbat/functions";
import type { GenericCtx } from "rabbat/functions";
import type { DataModelOf } from "@rabbat/schema";

import { schema } from "../schema.ts";

export type DataModel = DataModelOf<typeof schema>;

const base = defineFunctions<DataModel>();

// Public (no auth) builders.
export const publicQuery = base.query;
export const publicMutation = base.mutation;
export const publicAction = base.action;

// Authed builders — throw if there's no identity, and inject a non-null
// `ctx.user`. `GenericCtx` is the cross-kind base shared by Query/Mutation/Action
// ctx, so this one customizer types + reuses across all three. (The `{ input }`
// customizer is the Convex-helpers shape: `input` can also declare extra `args`
// and return `args` / `onSuccess` — unused here.)
function requireUser(ctx: GenericCtx) {
  if (!ctx.identity) throw new Error("Sign in required");
  return { ctx: { user: ctx.identity }, args: {} };
}
export const query = customQuery(base.query, { input: requireUser });
export const mutation = customMutation(base.mutation, { input: requireUser });
export const action = customAction(base.action, { input: requireUser });

// Server-only (never callable from the browser).
export const { internalQuery, internalMutation, internalAction } = base;
