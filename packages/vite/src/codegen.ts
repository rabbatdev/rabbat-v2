// Vite-free entry: pure Node discovery + generation, safe to import from the CLI
// without pulling in vite / @cloudflare/vite-plugin / react.
export { discover, type Discovery, type ModuleFile } from "./discover.js"
export { generateApi, generateWorkerEntry, generateWrangler } from "./generate.js"
