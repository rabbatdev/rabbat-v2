import { defineFunctions } from "@rabbat/functions"
import type { DataModelOf } from "@rabbat/schema"
import { schema } from "../schema.js"

export type DataModel = DataModelOf<typeof schema>

/** Schema-typed function builders — `ctx.db` is typed against the schema. */
const base = defineFunctions<DataModel>()
export const query = base.query
export const mutation = base.mutation
export const action = base.action
