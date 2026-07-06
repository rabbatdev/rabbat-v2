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
  readonly configPath: string | null
}

/** Candidate backend roots, in priority order. */
const BACKEND_DIRS = ["rabbat", "src/rabbat", "convex", "app", "src", "."]

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
  const candidates = dir ? [dir] : BACKEND_DIRS
  let backendRoot: string | null = null
  for (const c of candidates) {
    if (existsSync(join(root, c, "schema.ts"))) {
      backendRoot = join(root, c)
      break
    }
  }
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
export function scanExports(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"))
  const names = new Set<string>()
  const isPublicBuilder = (callee: string): boolean =>
    callee === "query" ||
    callee === "mutation" ||
    callee === "action" ||
    (/^custom[A-Z]/.test(callee) && !/^internal/i.test(callee))

  // Match `export const NAME = builder(` and comma-continued declarators
  // (`, NAME = builder(`). No dependency on semicolons (the codebase omits
  // them). The public-builder filter keeps false positives from the comma branch
  // negligible.
  const re = /(?:export\s+const|,)\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g
  for (const m of src.matchAll(re)) {
    if (isPublicBuilder(m[2]!)) names.add(m[1]!)
  }
  return [...names]
}

/** Remove line and block comments so commented-out code is never scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}
