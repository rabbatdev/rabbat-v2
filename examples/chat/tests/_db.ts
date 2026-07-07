// Test harness for the multi-tenant backend: ensure the shared Postgres + rabbat
// daemon are running, then provision a FRESH token (so each test run gets its own
// isolated app data) and upload the chat schema. Returns how the test should
// connect.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverModules,
  ensureBackend,
  ensurePostgres,
  generateToken,
  provisionApp,
  type ResolvedConfig,
} from "rabbat/cli";

const chatDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The function-module registry, discovered the same way the framework does (no
 *  hand-maintained `functions/index.ts`). Lazy: only imports the modules when a
 *  test actually starts a server. */
export const loadModules = () => discoverModules(path.join(chatDir, "functions"));

export async function setupTestApp(): Promise<{ dbUrl: string; token: string }> {
  const pg = await ensurePostgres({ port: 3654 });
  // Minimal config for the binary resolver + daemon ensure (avoids importing the
  // full chat config, which pulls in better-auth / uploadthing at module load).
  const config = {
    projectDir: chatDir,
    ports: { app: 3650, db: 3652, pg: 3654, hmr: 3655 },
    db: { bin: process.env.RABBAT_DB_BIN, allowUnindexedScans: true },
  } as unknown as ResolvedConfig;
  const backend = await ensureBackend(config, { pgUrl: pg.url });

  const token = generateToken("dev");
  const schemaJson = readFileSync(path.join(chatDir, "rabbat.schema.json"), "utf8");
  await provisionApp(backend.httpUrl, token, "chat-test", schemaJson);
  return { dbUrl: backend.url, token };
}
