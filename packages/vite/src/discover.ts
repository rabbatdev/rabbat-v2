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

/** Export names declared with `export const NAME` in a source file. */
export function scanExports(file: string): string[] {
  const src = readFileSync(file, "utf8")
  const names = new Set<string>()
  for (const m of src.matchAll(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)
  return [...names]
}
