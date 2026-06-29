/**
 * Local file-based Postgres for development — powered by PGlite.
 * ---------------------------------------------------------------------------
 * Why this exists
 *   The app talks to Postgres through `lib/db` (node-postgres + Drizzle) and
 *   uses Postgres-only features everywhere (jsonb, timestamptz, SERIAL,
 *   `INTERVAL`, `ON CONFLICT`, `information_schema`, `DO $$ … $$`,
 *   `ANY(ARRAY[…]::int[])`). True SQLite cannot run any of that.
 *
 *   PGlite is a real Postgres compiled to WASM. This script runs it as a tiny
 *   local server that speaks the Postgres wire protocol and persists to a
 *   folder on disk. `lib/db` connects to it with the SAME node-postgres driver
 *   and the SAME `DATABASE_URL` it uses on Replit — so local behaviour matches
 *   production exactly, and NONE of the app code, schema, routes, or build
 *   needs to change.
 *
 * Usage
 *   pnpm db:local                 # start (leave running)
 *   # then, in another terminal, point the app at it:
 *   #   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 *   #   PG_POOL_MAX=1
 *   pnpm db:push                  # create tables from the Drizzle schema
 *   pnpm --filter @workspace/scripts run seed   # (optional) demo data
 *
 * Env overrides
 *   PGLITE_DATA_DIR   data folder (default: <repo>/.local-pgdata)
 *   PGLITE_PORT       listen port (default: 5432)
 *   PGLITE_HOST       listen host (default: 127.0.0.1)
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../..");

  const dataDir = process.env.PGLITE_DATA_DIR
    ? path.resolve(process.env.PGLITE_DATA_DIR)
    : path.join(repoRoot, ".local-pgdata");
  const port = Number(process.env.PGLITE_PORT ?? 5432);
  const host = process.env.PGLITE_HOST ?? "127.0.0.1";

  mkdirSync(dataDir, { recursive: true });

  const pglite = await PGlite.create({ dataDir });
  const server = new PGLiteSocketServer({ db: pglite, port, host });
  await server.start();

  const url = `postgres://postgres:postgres@${host}:${port}/postgres`;
  /* eslint-disable no-console */
  console.log("");
  console.log("  ▶  Local PGlite Postgres is running (file-based, no server install needed)");
  console.log(`       data dir  : ${dataDir}`);
  console.log(`       listening : ${host}:${port}`);
  console.log("");
  console.log("  Put these in your local env (see .env.local.example):");
  console.log(`       DATABASE_URL=${url}`);
  console.log("       PG_POOL_MAX=1");
  console.log("");
  console.log("  First-time setup (in another terminal, with the env above loaded):");
  console.log("       pnpm db:push                                  # create tables from the schema");
  console.log("       pnpm --filter @workspace/scripts run seed     # optional demo data");
  console.log("");
  console.log("  Leave this process running while you develop. Press Ctrl-C to stop.");
  console.log("");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n  ${signal} received — stopping local PGlite…`);
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
    try {
      await pglite.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start local PGlite server:", err);
  process.exit(1);
});
