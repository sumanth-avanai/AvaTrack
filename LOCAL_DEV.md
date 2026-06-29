# Local development with a file-based database (PGlite)

This project runs on **Postgres** (via `lib/db` → node-postgres + Drizzle) and
relies on Postgres-only features throughout (`jsonb`, `timestamptz`, `SERIAL`,
`INTERVAL`, `ON CONFLICT`, `information_schema`, `DO $$ … $$`,
`ANY(ARRAY[…]::int[])`). To develop locally **without installing a Postgres
server** — and without changing any app code — we run
[**PGlite**](https://pglite.dev) (a real Postgres compiled to WASM) as a small
local server that persists to a folder on disk.

Because PGlite speaks the Postgres wire protocol, `lib/db` connects to it with
the **same node-postgres driver** and the **same `DATABASE_URL`** it uses on
Replit. Local behaviour therefore matches production exactly, and **nothing in
`lib/db`, the routes, the schema, the build, or `drizzle.config.ts` changes
between local and Replit.**

> The only code touched for this is `lib/db/src/index.ts`, which now reads an
> optional `PG_POOL_MAX` env var. It is **unset on Replit**, so Replit behaves
> exactly as before.

---

## One-time setup

```bash
# 1. Install dependencies (adds @electric-sql/pglite + pglite-socket).
pnpm install

# 2. Create your local env file and load it into the shell.
cp .env.local.example .env.local
set -a && source .env.local && set +a      # bash / zsh
```

> **Windows (PowerShell):** load the vars manually, e.g.
> `$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres"`,
> `$env:PG_POOL_MAX="1"`, `$env:PORT="8080"`, `$env:APP_ACCESS_PASSWORD="dev"`,
> `$env:SESSION_SECRET="dev"`. Each new terminal needs the vars loaded.

---

## Daily workflow (with `.env.local` loaded in every terminal)

```bash
# Terminal 1 — start the file-based Postgres and leave it running.
pnpm db:local

# Terminal 2 — create/refresh tables from the Drizzle schema (first run + after
# any schema change). This is the same drizzle-kit push used on Replit.
pnpm db:push

# (optional) load demo data
pnpm --filter @workspace/scripts run seed

# Terminal 2 — start the API and the web UI.
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/time-tracker run dev
```

The database lives in `./.local-pgdata/` (git-ignored and excluded from Replit
deploys). Delete that folder to start from a clean database, then re-run
`pnpm db:push` (+ seed).

---

## How it works

```
┌──────────────────┐     postgres:// wire      ┌───────────────────────────┐
│  api-server      │ ───── (node-postgres) ───▶ │  pnpm db:local            │
│  lib/db (Drizzle)│                            │  scripts/src/local-db.ts  │
└──────────────────┘                            │  → PGlite (WASM Postgres) │
        ▲                                        │  → ./.local-pgdata (disk) │
        │ same code path on Replit               └───────────────────────────┘
        │
   DATABASE_URL=postgres://…  (Replit Postgres in prod, local PGlite in dev)
```

`scripts/src/local-db.ts` boots PGlite with an on-disk data directory and
exposes it over TCP using `@electric-sql/pglite-socket`. Set `PG_POOL_MAX=1`
locally because PGlite is a single-connection engine (the app uses no
cross-connection transactions, so a pool of 1 is safe).

### Env overrides

| Variable           | Default              | Purpose                              |
| ------------------ | -------------------- | ------------------------------------ |
| `PGLITE_PORT`      | `5432`               | Port the local DB listens on         |
| `PGLITE_HOST`      | `127.0.0.1`          | Host the local DB binds to           |
| `PGLITE_DATA_DIR`  | `./.local-pgdata`    | Where the database files are stored  |
| `PG_POOL_MAX`      | (unset on Replit)    | Set to `1` locally for PGlite        |

---

## Windows (PowerShell) — full walkthrough

The Unix `pnpm db:local → db:push → seed → dev` flow needs a few Windows-only
adjustments. All of the code changes below are **no-ops on Replit/Linux**, so
production is unaffected.

### What already changed in the repo (so it works on Windows)

- **`lib/db/drizzle.config.ts`** — the schema path is normalized to forward
  slashes (`.replace(/\\/g, "/")`). drizzle-kit's globber treats Windows
  backslashes as escape chars and otherwise reports *"No schema files found"*.
- **`artifacts/time-tracker/vite.config.ts`** — a dev-only proxy forwards
  same-origin `/api` calls to the api-server, but **only when
  `API_PROXY_TARGET` is set**. On Replit it's unset (the platform router
  handles `/api`), so the proxy is absent.

### Ports

- The web UI's Vite config reads the **same `PORT`** env var as the api-server,
  so they must use **different ports** locally (api `8080`, web `5173`).
- If something already occupies `5432` (e.g. a real Postgres install), run
  PGlite on another port — this guide uses **`5433`** and points
  `DATABASE_URL` at it.

### One-time setup

```powershell
pnpm install
Copy-Item .env.local.example .env.local   # already set to port 5433 + PG_POOL_MAX=1
```

### Terminal 1 — start the file-based Postgres (leave running)

```powershell
$env:PGLITE_PORT="5433"; $env:PGLITE_HOST="127.0.0.1"
pnpm db:local
```

### Terminal 2 — create tables, then seed (first run only)

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5433/postgres"
$env:PG_POOL_MAX="1"
pnpm db:push
```

> ⚠️ **Restart `db:local` (Ctrl-C in Terminal 1, then `pnpm db:local` again)
> before seeding.** Running `db:push` and `seed` back-to-back against the same
> PGlite instance corrupts the pglite-socket multiplexer (`ECONNRESET`). A
> fresh restart between them avoids it; the on-disk data in `.local-pgdata/`
> persists across restarts, so you don't re-push.

```powershell
pnpm --filter @workspace/scripts run seed
```

### Terminal 2 — start the API (its `dev` script is bash-only, so run the steps directly)

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5433/postgres"
$env:PG_POOL_MAX="1"; $env:PORT="8080"
$env:APP_ACCESS_PASSWORD="dev"; $env:SESSION_SECRET="dev-secret-change-me"
$env:NODE_ENV="development"
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

### Terminal 3 — start the web UI

```powershell
$env:PORT="5173"; $env:BASE_PATH="/"
$env:API_PROXY_TARGET="http://localhost:8080"
$env:NODE_ENV="development"
pnpm --filter @workspace/time-tracker run dev
```

Open **http://localhost:5173**, enter the access password (`APP_ACCESS_PASSWORD`,
e.g. `dev`), and you're in. Demo employee PINs are printed by the seed script.

---

## Going back to Replit

Nothing to undo. On Replit, `DATABASE_URL` points at the provisioned Postgres
and `PG_POOL_MAX` is unset, so the app uses the normal node-postgres pool and
the managed database — exactly as before. The local-only files
(`.local-pgdata/`, `.env.local`) are git-ignored and Replit-ignored.
