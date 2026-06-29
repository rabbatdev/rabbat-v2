import type {
  CompareOp,
  Filter,
  OrderKey,
  PaginationOpts,
  QuerySpec,
  Row as AnyRow,
  Scalar,
} from "@rabbat/protocol"
import type { DataModel } from "@rabbat/schema"

/** A live, bi-directional page of rows plus window metadata. */
export interface Paginated<R> {
  readonly __paginated: true
  readonly page: ReadonlyArray<R>
  readonly total: number
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly pk: string
}

/** Default rows scanned by `.collect()` / `.first()` without an explicit limit. */
export const COLLECT_LIMIT = 4096

/**
 * The low-level access surface the runtime injects. In `ctx.db` it is backed by
 * the engine; in reactive capture mode it also records each read's QuerySpec so
 * the Durable Object knows what to re-run and diff on a write.
 */
export interface DbExecutor {
  collect(spec: QuerySpec, limit: number): Promise<AnyRow[]>
  paginate(spec: QuerySpec, opts: PaginationOpts): Promise<Paginated<AnyRow>>
  get(table: string, id: Scalar): Promise<AnyRow | null>
  insert(table: string, row: AnyRow): Promise<void>
  patch(table: string, id: Scalar, fields: AnyRow): Promise<void>
  remove(table: string, id: Scalar): Promise<void>
}

export class QueryBuilder<R extends AnyRow> {
  private filters: Filter[] = []
  private orderKeys: OrderKey[] = []

  constructor(
    private readonly exec: DbExecutor,
    private readonly table: string,
  ) {}

  where(filter: Partial<R>): this
  where(column: keyof R & string, op: Exclude<CompareOp, "in">, value: Scalar): this
  where(column: keyof R & string, op: "in", values: ReadonlyArray<Scalar>): this
  where(a: Partial<R> | (keyof R & string), op?: CompareOp, value?: Scalar | ReadonlyArray<Scalar>): this {
    if (typeof a === "string") {
      this.filters.push({ column: a, op: op!, value: value as Scalar | ReadonlyArray<Scalar> })
    } else {
      for (const [column, v] of Object.entries(a)) {
        this.filters.push({ column, op: "=", value: v as Scalar })
      }
    }
    return this
  }

  order(column: keyof R & string, dir: "asc" | "desc" = "asc"): this {
    this.orderKeys.push({ column, desc: dir === "desc" })
    return this
  }

  private spec(): QuerySpec {
    return { table: this.table, filters: this.filters, order: this.orderKeys }
  }

  collect(): Promise<R[]> {
    return this.exec.collect(this.spec(), COLLECT_LIMIT) as Promise<R[]>
  }
  take(n: number): Promise<R[]> {
    return this.exec.collect(this.spec(), n) as Promise<R[]>
  }
  async first(): Promise<R | null> {
    const rows = await this.exec.collect(this.spec(), 1)
    return (rows[0] as R | undefined) ?? null
  }
  paginate(opts: PaginationOpts): Promise<Paginated<R>> {
    return this.exec.paginate(this.spec(), opts) as Promise<Paginated<R>>
  }
}

export interface DatabaseReader<DM extends DataModel> {
  table<T extends keyof DM & string>(name: T): QueryBuilder<DM[T]["row"]>
  get<T extends keyof DM & string>(name: T, id: Scalar): Promise<DM[T]["row"] | null>
}

export interface DatabaseWriter<DM extends DataModel> extends DatabaseReader<DM> {
  insert<T extends keyof DM & string>(name: T, value: DM[T]["insert"]): Promise<void>
  patch<T extends keyof DM & string>(name: T, id: Scalar, fields: DM[T]["patch"]): Promise<void>
  delete<T extends keyof DM & string>(name: T, id: Scalar): Promise<void>
}

export function makeReader<DM extends DataModel>(exec: DbExecutor): DatabaseReader<DM> {
  return {
    table: (name) => new QueryBuilder(exec, name),
    get: (name, id) => exec.get(name, id) as Promise<never>,
  }
}

export function makeWriter<DM extends DataModel>(exec: DbExecutor): DatabaseWriter<DM> {
  return {
    ...makeReader<DM>(exec),
    insert: (name, value) => exec.insert(name, value as AnyRow),
    patch: (name, id, fields) => exec.patch(name, id, fields as AnyRow),
    delete: (name, id) => exec.remove(name, id),
  }
}
