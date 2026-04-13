# Zeit — Internal Time Tracker

## Overview

A lightweight internal time-tracking web app for small agencies. Feels like a better spreadsheet, not a heavy ERP. Inspired by Productive/MOCO but much simpler.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind (at `/`)
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run seed` — seed demo data

## Features

### Admin Area (`/`)
- **Dashboard** — weekly summary: total/billable hours, per-employee utilization cards
- **Timesheet** — select any employee, spreadsheet-style grid (projects × Mon-Sun), auto-save with debounce, capacity warnings
- **Clients** — create/edit/archive with active toggle
- **Projects** — linked to clients, billable flag, budget hours
- **Employees** — weekly capacity, working days mask, personal link management + PIN reset
- **Holidays** — manage holiday calendars (DE-BASE-2026 preloaded)
- **Reports** — Utilization / Projects / Clients tabs with date range filter + CSV export

### Employee Personal Links (`/u/:token`)
- PIN-protected personal URL per employee
- Shows only own timesheet after PIN verified (stored in sessionStorage)

## Demo Credentials
- **Max Mustermann** (40h, Mon-Fri) — PIN: `1234`
- **Anna Beispiel** (20h, Mon-Fri) — PIN: `5678`
- **Paul Teilzeit** (32h, Mon-Thu) — PIN: `9999`

Employee personal link tokens can be found via `/api/employees` or the Employees admin page.

## Utilization Logic

`artifacts/api-server/src/lib/utilization.ts`

- **Daily capacity** = weeklyCapacityHours / number of working days per week
- **Available hours** = sum of daily capacity for each working day in period, minus holidays that fall on working days
- **Billable utilization** = billable hours / available hours
- **Overall utilization** = total booked hours / available hours
- Holidays on non-working days: no deduction

## Database Schema

- `clients` — clients table
- `projects` — projects (belongs to client, billable flag)
- `employees` — employees with capacity, working days mask, hashed PIN, access token
- `holiday_calendars` — calendar registry (DE-BASE-2026 seeded)
- `holidays` — individual holiday dates per calendar
- `time_entries` — time entries (employee, project, date, hours, note)

## Architecture

```
artifacts/
  api-server/      # Express 5 backend
    src/routes/    # clients, projects, employees, holidays, timeEntries, reports, dashboard, auth
    src/lib/       # utilization.ts, crypto.ts
  time-tracker/    # React + Vite frontend
    src/pages/     # Dashboard, Timesheet, Clients, Projects, Employees, Holidays, Reports, EmployeePortal
lib/
  api-spec/        # openapi.yaml (source of truth)
  api-client-react/ # Generated React Query hooks
  api-zod/         # Generated Zod schemas (used by server)
  db/              # Drizzle schema + client
scripts/
  src/seed.ts      # Demo data seeder
```
