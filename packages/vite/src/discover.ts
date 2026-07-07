import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export interface ModuleFile {
  /** Module name (path under functions/, without extension, slash-joined). */
  readonly name: string
  /** Absolute path to the source file. */
  readonly path: string
}

export interface Discovery {
  readonly root: string
  /** The backend root folder, e.g. `<root>/rabbat`. */
  readonly backendRoot: string
  /** `<backendRoot>/schema.ts` — the shared data model. */
  readonly schemaPath: string
  /** `<backendRoot>/functions` — query/mutation/action files. */
  readonly functionsDir: string
  /** `<backendRoot>/_generated` — where api/worker/wrangler are emitted. */
  readonly generatedDir: string
  readonly modules: ReadonlyArray<ModuleFile>
  /** Modules exposed in the typed `api` tree (excludes setup/underscore files). */
  readonly apiModules: ReadonlyArray<ModuleFile>
  /** `defineServerRoute` files under `<backendRoot>/api/` (default-exported). */
  readonly serverRoutes: ReadonlyArray<ModuleFile>
  readonly configPath: string | null
}

/** Candidate backend roots, in priority order. */
const BACKEND_DIRS = ["rabbat", "src/rabbat", "convex", "app", "src", "."]

/** Locate the rabbat convention root (the directory containing `schema.ts`). */
export function findBackendRoot(root: string, dir?: string): string | null {
  for (const c of dir ? [dir] : BACKEND_DIRS) {
    if (existsSync(join(root, c, "schema.ts"))) return join(root, c)
  }
  return null
}

function walk(dir: string, base: string, out: ModuleFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, base, out)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.startsWith("_")) {
      const name = relative(base, full).replace(/\.ts$/, "").replace(/\\/g, "/")
      out.push({ name, path: full })
    }
  }
}

/**
 * Discover the backend: the `rabbat/` root (frontend lives in `src/`), its
 * `schema.ts`, its `functions/` directory, and an optional config. This is the
 * convention that lets a user write only a schema + functions: each concern is a
 * folder under the backend root (functions/ today, crons/ and workflows/ next),
 * with the shared schema at the root.
 */
export function discover(root: string, dir?: string): Discovery {
  const backendRoot = findBackendRoot(root, dir)
  if (!backendRoot) {
    throw new Error(`rabbat: no schema.ts found in a backend root (looked in ${BACKEND_DIRS.join(", ")})`)
  }

  const schemaPath = join(backendRoot, "schema.ts")
  const functionsDir = join(backendRoot, "functions")
  if (!existsSync(functionsDir)) throw new Error(`rabbat: no functions/ directory in ${backendRoot}`)

  const modules: ModuleFile[] = []
  walk(functionsDir, functionsDir, modules)
  modules.sort((a, b) => a.name.localeCompare(b.name))

  const apiModules = modules.filter((m) => m.name !== "setup")

  // `defineServerRoute` files under `api/` (default-exported edge routes).
  const serverRoutes: ModuleFile[] = []
  const apiDir = join(backendRoot, "api")
  if (existsSync(apiDir)) walk(apiDir, apiDir, serverRoutes)
  serverRoutes.sort((a, b) => a.name.localeCompare(b.name))

  const configPath =
    [join(backendRoot, "config.ts"), join(root, "rabbat.config.ts")].find((p) => existsSync(p)) ?? null

  return {
    root,
    backendRoot,
    schemaPath,
    functionsDir,
    generatedDir: join(backendRoot, "_generated"),
    modules,
    apiModules,
    serverRoutes,
    configPath,
  }
}

/**
 * The public, client-callable functions exported by a module — the entries that
 * belong in the generated `api` tree.
 *
 * Only exports whose initializer is a call to a public builder (`query`,
 * `mutation`, `action`, or a `custom*` wrapper) are included; plain constants
 * (`export const LIMIT = 10`) and server-only `internal*` functions are
 * excluded, so the api tree never contains a `never`-typed node or exposes an
 * internal function to the browser. Handles `export function`, `export { a }`
 * re-exports, and multi-declarator `export const a = …, b = …`.
 */
/** A discovered function export and whether it is server-only (`internal*`). */
export interface FunctionExport {
  readonly name: string
  readonly internal: boolean
}

/** Is `callee` a known function builder? Returns its visibility, or null. */
function builderKind(callee: string): "public" | "internal" | null {
  // Server-only builders (Convex-style): internalQuery/internalMutation/internalAction.
  if (/^internal(Query|Mutation|Action)$/.test(callee)) return "internal"
  // Public builders: the primitives, the `public*` aliases apps commonly define
  // in a setup module, and `custom*` wrappers (customQuery/customMutation/...).
  if (/^(public)?(query|mutation|action)$/i.test(callee)) return "public"
  if (/^custom[A-Z]/.test(callee)) return "public"
  return null
}

/**
 * The public + internal function exports of a module, classified by the builder
 * each is bound to. Recognizes the app's aliased builders (a `setup.ts` that
 * re-exports `query`/`publicQuery`/`internalMutation` etc.), so the generated
 * `api`/`internal` trees are complete even when builders are aliased. Handles
 * multi-declarator `export const a = …, b = …` and omitted semicolons.
 */
export function scanFunctionExports(file: string): FunctionExport[] {
  const src = stripComments(readFileSync(file, "utf8"))
  const seen = new Map<string, boolean>()
  const re = /(?:export\s+const|,)\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g
  for (const m of src.matchAll(re)) {
    const kind = builderKind(m[2]!)
    if (kind && !seen.has(m[1]!)) seen.set(m[1]!, kind === "internal")
  }
  return [...seen].map(([name, internal]) => ({ name, internal }))
}

/** Public (client-callable) function export names — the `api` tree entries. */
export function scanExports(file: string): string[] {
  return scanFunctionExports(file).filter((e) => !e.internal).map((e) => e.name)
}

/** Remove line and block comments so commented-out code is never scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}
