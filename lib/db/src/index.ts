import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Optional cap on the connection pool size. Leave UNSET in production
// (Replit / managed Postgres) so node-postgres keeps its normal default —
// this file therefore behaves exactly as before on Replit.
//
// For local development against the file-based PGlite server
// (see scripts/src/local-db.ts), set PG_POOL_MAX=1, because PGlite is a
// single-connection engine and a larger pool would drop connections.
const poolMax = process.env.PG_POOL_MAX
  ? Number(process.env.PG_POOL_MAX)
  : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(poolMax && Number.isFinite(poolMax) ? { max: poolMax } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
