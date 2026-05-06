# AvaTrack — Internal Time Tracker

## Overview

A lightweight internal time-tracking web app for small agencies, branded as **AvaTrack** with Avanai colors (purple #8B5CF6 / cyan #06B6D4 gradient). Feels like a premium SaaS tool (Linear/Vercel aesthetic), not a heavy ERP. Inspired by Productive/MOCO but much simpler.

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
- **Timesheet** — select any employee, spreadsheet-style grid (projects × Mon-Sun), explicit Save button (Ctrl+S), capacity warnings
- **Clients** — create/edit/archive with active toggle
- **Projects** — linked to clients, billable flag, budget hours
- **Employees** — weekly capacity, working days mask, contract start/end dates, personal link management + PIN reset
- **Holidays** — manage holiday calendars (DE-BASE-2026 preloaded)
- **Vacations** — absence/vacation management per employee (vacation, sick, unpaid leave, other); filterable by employee; correctly deducted from utilization
- **Reports** — Pivot/flat reporting with 9 date presets, multi-select filters, metric selector, CSV export
- **Project Roles (T&M)** — Per-project role management (name, day rate €/day, budgeted days, assigned employees); role selection in Timesheet "Add Project" flow; Budget tab with booked vs. budgeted per role; Allocations tab with planned vs. booked per employee per role
- **Billing** — Revenue tracking per project: logged vs invoiced vs unbilled per role/employee; period presets (this/last month, quarter, all time, custom); 5 KPI cards; collapsible role/employee table with colour-coded unbilled amounts; "Mark all as invoiced" modal with optional invoice reference; CSV export

### Employee Personal Links (`/u/:token`)
- PIN-protected personal URL per employee (route no longer requires admin session)
- Shows only own timesheet after PIN verified (stored in sessionStorage)
- **Role-filtered**: employees see only their assigned project roles via `PortalTimesheetGrid`
- Legacy entries (time logged before role assignment) shown with a "legacy" badge
- Projects are collapsible; a "Planned" column shows hours from active resource bookings
- Save validates assignments server-side (403 for unassigned roles); grandfathers existing entries

## Demo Credentials
- **Max Mustermann** (40h, Mon-Fri, since 2024-01-01) — PIN: `1234`
- **Anna Beispiel** (20h, Mon-Fri, since 2025-06-01) — PIN: `5678`
- **Paul Teilzeit** (32h, Mon-Thu, 2026-01-15 to 2026-12-31) — PIN: `9999`

Employee personal link tokens can be found via `/api/employees` or the Employees admin page.

## Utilization Logic

`artifacts/api-server/src/lib/utilization.ts`

- **Daily capacity** = weeklyCapacityHours / number of working days per week
- **Available hours** = sum of daily capacity for each working day in period, minus:
  - Public holidays that fall on working days (from employee's holiday calendar)
  - Vacation/absence days that fall on working days (from `employee_vacations`)
  - Days outside the employee's contract period (before `contract_start_date` or after `contract_end_date`)
- **Billable utilization** = billable hours / available hours
- **Overall utilization** = total booked hours / available hours

## Database Schema

- `clients` — clients table
- `projects` — projects (belongs to client, billable flag)
- `employees` — employees with capacity, working days mask, contract dates, hashed PIN, access token
- `employee_vacations` — absence entries (vacation/sick/unpaid_leave/other) per employee with date ranges
- `holiday_calendars` — calendar registry (DE-BASE-2026 seeded)
- `holidays` — individual holiday dates per calendar
- `time_entries` — time entries (employee, project, optional `project_role_id`, date, hours, note, `invoiced_at` timestamptz nullable, `invoice_reference` varchar(100) nullable)
- `project_roles` — T&M roles per project (name, day_rate, budgeted_days, budgeted_hours)
- `project_role_assignments` — many-to-many: employee assigned to a project role

## Architecture

```
artifacts/
  api-server/      # Express 5 backend
    src/routes/    # clients, projects, employees, holidays, timeEntries, reports, pivot, vacations, dashboard, auth, billing
    src/lib/       # utilization.ts, employee-availability.ts, crypto.ts
  time-tracker/    # React + Vite frontend
    src/pages/     # Dashboard, Timesheet, Clients, Projects, Employees, Holidays, Vacations, Reports, Billing, EmployeePortal
lib/
  api-spec/        # openapi.yaml (source of truth)
  api-client-react/ # Generated React Query hooks
  api-zod/         # Generated Zod schemas (used by server)
  db/              # Drizzle schema + client
scripts/
  src/seed.ts      # Demo data seeder
```

## API Endpoints (vacation/absence — not in OpenAPI spec, called directly)

```
GET    /api/vacations?employeeId=X  — list absence entries (all or filtered by employee)
POST   /api/vacations               — create entry { employeeId, startDate, endDate, vacationType, note }
PATCH  /api/vacations/:id           — update entry (partial)
DELETE /api/vacations/:id           — delete entry
```

## API Endpoints (employee timesheet portal — not in OpenAPI spec, called directly)

```
GET  /api/employee-timesheet/:employeeId/week/:weekStart?token=   — load portal timesheet (assignments, bookings, entries)
POST /api/employee-timesheet/:employeeId/week/:weekStart?token=   — save timesheet entries (validates role assignment)
```
- Routes are public (bypasses admin session check), validated by employee's `personalAccessToken` query param
- GET returns `availableProjects`, `prefilled` rows with `isLegacy` flag and `plannedHours` from resource bookings
- POST grandfathers existing entries; new entries with unassigned roles receive 403

## API Endpoints (project roles — not in OpenAPI spec, called directly)

```
GET    /api/projects/:id/roles               — list roles for project (enriched with assignedEmployees[])
POST   /api/projects/:id/roles               — create role { name, dayRate, budgetedDays?, budgetedHours?, assignedEmployeeIds? }
PUT    /api/project-roles/:id                — update role (partial, replaces assignedEmployeeIds if provided)
DELETE /api/project-roles/:id               — delete role (cascades assignments + time entry FK to null)
GET    /api/project-roles/:id/budget-status  — planned days vs. budgeted days from resource bookings
GET    /api/projects/:id/budget              — booked/planned days per role with totals
GET    /api/projects/:id/allocations         — per-employee per-role allocation vs. booked summary
```

## Important Notes

- API server imports `zod/v4` — NOT plain `zod` (esbuild won't resolve plain "zod")
- `calculateAvailableHours()` signature: (startDate, endDate, mask, weeklyHrs, holidayDates, vacationSet, contractStart?, contractEnd?)
- `fetchEmpAvailabilityMap()` in `employee-availability.ts` — shared helper for dashboard/reports/pivot to fetch holidays+vacations in one pass
- Working days mask stored as "1,1,1,1,1,0,0" (Mon=index 0, Sun=index 6); use `getUTCDay()` for weekday detection
- PINs are SHA-256 hashed; access tokens are base64url random 24 bytes
