#!/usr/bin/env node
import { spawn } from "node:child_process"
import { distWranglerConfig, runCodegen } from "./codegen.js"

const HELP = `rabbat — reactive database on Cloudflare (R2 + Durable Objects + Effect)

Usage:
  rabbat dev        Run the whole app (React + Worker + Durable Object + R2) on Miniflare
  rabbat build      Build the client + Worker for deployment
  rabbat deploy     Build, then deploy the Worker + Durable Object to Cloudflare
  rabbat codegen    Generate the typed api tree + Worker wiring from schema.ts + functions/
  rabbat help       Show this help

You write schema.ts, functions/, and a React app — rabbat wires Vite, the Worker,
the Durable Object, and wrangler for you.
`

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })
    child.on("close", (code) => resolve(code ?? 0))
    child.on("error", () => {
      process.stderr.write(`rabbat: could not run \`${cmd}\` — is it installed in this project?\n`)
      resolve(1)
    })
  })
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case "dev":
      // `vite` runs the React app + the Worker (DO + R2) together via @rabbat/vite.
      process.exit(await run("vite", ["dev", ...rest]))
      break
    case "build":
      process.exit(await run("vite", ["build", ...rest]))
      break
    case "deploy": {
      const code = await run("vite", ["build"])
      if (code !== 0) process.exit(code)
      process.exit(await run("wrangler", ["deploy", "-c", distWranglerConfig(process.cwd()), ...rest]))
      break
    }
    case "codegen":
      runCodegen(process.cwd())
      break
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP)
      break
    default:
      process.stderr.write(`rabbat: unknown command "${cmd}"\n\n${HELP}`)
      process.exit(1)
  }
}

void main()
