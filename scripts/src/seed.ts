/**
 * Seed script — run with:
 *   pnpm --filter @workspace/scripts run seed
 *
 * Idempotent: every entity is checked by natural key before insert.
 * Safe to re-run on a fresh DB or on top of the legacy minimal seed.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  clientsTable,
  projectsTable,
  employeesTable,
  holidayCalendarsTable,
  holidaysTable,
  timeEntriesTable,
  employeeVacationsTable,
  projectRolesTable,
  projectRoleAssignmentsTable,
  resourceBookingsTable,
} from "@workspace/db";
import { createHash, randomBytes } from "crypto";
import { eq, and, gte, lte, inArray, sql } from "drizzle-orm";

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db   = drizzle(pool);

function hashPin(pin: string)  { return createHash("sha256").update(pin).digest("hex"); }
function generateToken()        { return randomBytes(24).toString("base64url"); }
function toIsoDate(d: Date)     { return d.toISOString().slice(0, 10); }

/** All calendar dates [start, end] inclusive */
function dateRange(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Working days in [start, end] for an employee, excluding holidays and vacation dates */
function workingDays(start: Date, end: Date, mask: string, holidays: Set<string>, vacations: Set<string>): Date[] {
  const m = mask.split(",").map(Number);
  return dateRange(start, end).filter((d) => {
    const dow = d.getUTCDay();
    const idx = dow === 0 ? 6 : dow - 1; // Mon=0…Sun=6
    const ds  = toIsoDate(d);
    return m[idx] === 1 && !holidays.has(ds) && !vacations.has(ds);
  });
}

/** Expand a vacation date range into a Set of ISO date strings */
function vacationDateSet(startIso: string, endIso: string): Set<string> {
  const s = new Set<string>();
  for (const d of dateRange(new Date(startIso), new Date(endIso))) s.add(toIsoDate(d));
  return s;
}

// ── Upsert helpers ────────────────────────────────────────────────────────────

async function upsertClient(name: string, active: boolean, notes: string | null) {
  const [existing] = await db.select().from(clientsTable).where(eq(clientsTable.name, name));
  if (existing) return existing;
  const [row] = await db.insert(clientsTable).values({ name, active, notes }).returning();
  return row;
}

async function upsertEmployee(values: {
  name: string; email: string;
  weeklyCapacityHours: number; workingDaysMask: string;
  holidayCalendarCode: string;
  contractStartDate?: string; contractEndDate?: string;
  utilizationTarget?: number;
  personalAccessPinHash: string;
}) {
  const [existing] = await db.select().from(employeesTable).where(eq(employeesTable.name, values.name));
  if (existing) return existing;
  const [row] = await db.insert(employeesTable).values({ ...values, personalAccessToken: generateToken(), active: true }).returning();
  return row;
}

async function upsertProject(values: {
  clientId: number; name: string; code: string; active: boolean;
  isBillable: boolean; budgetHours: number | null;
  startDate: string | null; endDate: string | null;
  color: string | null; pmName: string | null;
}) {
  const [existing] = await db.select().from(projectsTable).where(eq(projectsTable.code, values.code));
  if (existing) return existing;
  const [row] = await db.insert(projectsTable).values(values).returning();
  return row;
}

async function upsertRole(projectId: number, name: string, dayRate: number, budgetedDays: number) {
  const [existing] = await db.select().from(projectRolesTable)
    .where(and(eq(projectRolesTable.projectId, projectId), eq(projectRolesTable.name, name)));
  if (existing) return existing;
  const [row] = await db.insert(projectRolesTable).values({
    projectId, name, dayRate, budgetedDays, budgetedHours: budgetedDays * 8,
  }).returning();
  return row;
}

async function upsertAssignment(projectRoleId: number, employeeId: number) {
  const [existing] = await db.select().from(projectRoleAssignmentsTable)
    .where(and(
      eq(projectRoleAssignmentsTable.projectRoleId, projectRoleId),
      eq(projectRoleAssignmentsTable.employeeId, employeeId),
    ));
  if (existing) return existing;
  const [row] = await db.insert(projectRoleAssignmentsTable).values({ projectRoleId, employeeId }).returning();
  return row;
}

async function upsertVacation(employeeId: number, startDate: string, endDate: string, vacationType: string, note: string | null) {
  const [existing] = await db.select().from(employeeVacationsTable)
    .where(and(
      eq(employeeVacationsTable.employeeId, employeeId),
      eq(employeeVacationsTable.startDate, startDate),
      eq(employeeVacationsTable.endDate, endDate),
      eq(employeeVacationsTable.vacationType, vacationType),
    ));
  if (existing) return;
  await db.insert(employeeVacationsTable).values({ employeeId, startDate, endDate, vacationType, note });
}

async function upsertBooking(values: {
  employeeId: number; projectId: number; projectRoleId: number;
  startDate: string; endDate: string; hoursPerDay: number; notes?: string;
}) {
  const [existing] = await db.select().from(resourceBookingsTable)
    .where(and(
      eq(resourceBookingsTable.employeeId, values.employeeId),
      eq(resourceBookingsTable.projectId, values.projectId),
      eq(resourceBookingsTable.projectRoleId, values.projectRoleId),
      eq(resourceBookingsTable.startDate, values.startDate),
      eq(resourceBookingsTable.endDate, values.endDate),
    ));
  if (existing) return;
  await db.insert(resourceBookingsTable).values(values);
}

// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding database…");

  // ── Holiday Calendar ────────────────────────────────────────────────────────
  const [existingCal] = await db.select().from(holidayCalendarsTable)
    .where(eq(holidayCalendarsTable.code, "DE-BASE-2026"));

  let calendarId: number;
  if (existingCal) {
    calendarId = existingCal.id;
    console.log("  Holiday calendar already exists, skipping.");
  } else {
    const [cal] = await db.insert(holidayCalendarsTable)
      .values({ code: "DE-BASE-2026", name: "Germany Base Public Holidays 2026" })
      .returning();
    calendarId = cal.id;
    await db.insert(holidaysTable).values([
      { calendarId, date: "2026-01-01", name: "New Year's Day" },
      { calendarId, date: "2026-04-03", name: "Good Friday" },
      { calendarId, date: "2026-04-06", name: "Easter Monday" },
      { calendarId, date: "2026-05-01", name: "Labour Day" },
      { calendarId, date: "2026-05-14", name: "Ascension Day" },
      { calendarId, date: "2026-05-25", name: "Whit Monday" },
      { calendarId, date: "2026-10-03", name: "German Unity Day" },
      { calendarId, date: "2026-12-25", name: "Christmas Day" },
      { calendarId, date: "2026-12-26", name: "Second Day of Christmas" },
    ]);
    console.log("  Created DE-BASE-2026 calendar with 9 holidays.");
  }

  // Public holidays relevant to Apr–Jun 2026
  const HOLIDAYS = new Set([
    "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-25",
  ]);

  // ── Clients ─────────────────────────────────────────────────────────────────
  const acme    = await upsertClient("Acme Corp",     true,  "Main enterprise client");
  const bravo   = await upsertClient("Bravo Studios", true,  "Design retainer client");
  const delta   = await upsertClient("Delta Finance", true,  "Fintech ERP project");
  const echo    = await upsertClient("Echo Retail",   true,  "E-commerce & analytics");
  const foxtrot = await upsertClient("Foxtrot GmbH",  false, "Archived — migration project complete");
  console.log("  Clients: 5 ensured.");

  // ── Projects ─────────────────────────────────────────────────────────────────
  const pAcmeWeb   = await upsertProject({ clientId: acme.id,    name: "Website Redesign",     code: "ACME-WEB",   active: true,  isBillable: true,  budgetHours: 200,  startDate: "2026-01-01", endDate: "2026-06-30", color: "#6366f1", pmName: "Max Mustermann" });
  const pAcmeSup   = await upsertProject({ clientId: acme.id,    name: "Support & Maintenance", code: "ACME-SUP",   active: true,  isBillable: true,  budgetHours: null, startDate: "2026-01-01", endDate: null,         color: "#f59e0b", pmName: "Paul Teilzeit" });
  const pBravoId   = await upsertProject({ clientId: bravo.id,   name: "Brand Identity",        code: "BRAVO-ID",   active: true,  isBillable: false, budgetHours: 40,   startDate: "2026-03-01", endDate: "2026-05-31", color: "#ec4899", pmName: "Anna Beispiel" });
  const pAcmeApp   = await upsertProject({ clientId: acme.id,    name: "Mobile App Dev",        code: "ACME-APP",   active: true,  isBillable: true,  budgetHours: 320,  startDate: "2026-02-01", endDate: "2026-08-31", color: "#8b5cf6", pmName: "Max Mustermann" });
  const pDeltaErp  = await upsertProject({ clientId: delta.id,   name: "ERP Integration",       code: "DELTA-ERP",  active: true,  isBillable: true,  budgetHours: 480,  startDate: "2026-03-15", endDate: "2026-09-30", color: "#0ea5e9", pmName: "Sophie Wagner" });
  const pDeltaSec  = await upsertProject({ clientId: delta.id,   name: "Security Audit",        code: "DELTA-SEC",  active: true,  isBillable: true,  budgetHours: 80,   startDate: "2026-04-01", endDate: "2026-05-31", color: "#ef4444", pmName: "Sophie Wagner" });
  const pEchoShop  = await upsertProject({ clientId: echo.id,    name: "E-Commerce Platform",   code: "ECHO-SHOP",  active: true,  isBillable: true,  budgetHours: 560,  startDate: "2026-02-15", endDate: "2026-10-31", color: "#10b981", pmName: "Lars König" });
  const pEchoAna   = await upsertProject({ clientId: echo.id,    name: "Analytics Dashboard",   code: "ECHO-ANA",   active: true,  isBillable: true,  budgetHours: 240,  startDate: "2026-04-01", endDate: "2026-07-31", color: "#06b6d4", pmName: "Lars König" });
  const pFoxMigr   = await upsertProject({ clientId: foxtrot.id, name: "Data Migration",        code: "FOX-MIGR",   active: false, isBillable: true,  budgetHours: 160,  startDate: "2026-01-01", endDate: "2026-03-31", color: "#84cc16", pmName: "Mia Fischer" });
  const pBravoCamp = await upsertProject({ clientId: bravo.id,   name: "Campaign Creative",     code: "BRAVO-CAMP", active: true,  isBillable: false, budgetHours: 64,   startDate: "2026-04-01", endDate: "2026-06-30", color: "#f97316", pmName: "Anna Beispiel" });
  console.log("  Projects: 10 ensured.");

  // ── Project Roles ─────────────────────────────────────────────────────────────
  const rAcmeWebFE   = await upsertRole(pAcmeWeb.id,   "Frontend Dev",        800,  20);
  const rAcmeWebBE   = await upsertRole(pAcmeWeb.id,   "Backend Dev",         900,  15);
  const rAcmeWebUX   = await upsertRole(pAcmeWeb.id,   "UX Design",           750,  10);
  const rAcmeSupSup  = await upsertRole(pAcmeSup.id,   "Support Engineer",    700,  30);
  const rAcmeSupOps  = await upsertRole(pAcmeSup.id,   "DevOps",              850,  10);
  const rBravoIdDes  = await upsertRole(pBravoId.id,   "Brand Designer",      750,   8);
  const rBravoIdDir  = await upsertRole(pBravoId.id,   "Creative Director",  1000,   4);
  const rAcmeAppMob  = await upsertRole(pAcmeApp.id,   "Mobile Dev",          950,  25);
  const rAcmeAppBE   = await upsertRole(pAcmeApp.id,   "Backend Dev",         900,  20);
  const rAcmeAppPM   = await upsertRole(pAcmeApp.id,   "Project Manager",     800,  10);
  const rDeltaErpBE  = await upsertRole(pDeltaErp.id,  "Backend Dev",         900,  40);
  const rDeltaErpArch= await upsertRole(pDeltaErp.id,  "Solution Architect", 1200,  15);
  const rDeltaErpQA  = await upsertRole(pDeltaErp.id,  "QA Engineer",         650,  15);
  const rDeltaSecAna = await upsertRole(pDeltaSec.id,  "Security Analyst",   1100,  10);
  const rDeltaSecPen = await upsertRole(pDeltaSec.id,  "Penetration Tester", 1300,   5);
  const rEchoShopFE  = await upsertRole(pEchoShop.id,  "Frontend Dev",        800,  30);
  const rEchoShopBE  = await upsertRole(pEchoShop.id,  "Backend Dev",         900,  25);
  const rEchoShopQA  = await upsertRole(pEchoShop.id,  "QA Engineer",         650,  15);
  const rEchoShopOps = await upsertRole(pEchoShop.id,  "DevOps",              850,  10);
  const rEchoAnaDE   = await upsertRole(pEchoAna.id,   "Data Engineer",       950,  20);
  const rEchoAnaViz  = await upsertRole(pEchoAna.id,   "Visualization Spec",  850,  10);
  const rEchoAnaBE   = await upsertRole(pEchoAna.id,   "Backend Dev",         900,  12);
  const rFoxMigrDA   = await upsertRole(pFoxMigr.id,   "Data Analyst",        850,  20);
  const rFoxMigrBE   = await upsertRole(pFoxMigr.id,   "Backend Dev",         900,  15);
  const rBravoCampCS = await upsertRole(pBravoCamp.id,  "Creative Strategist", 800,  10);
  const rBravoCampCW = await upsertRole(pBravoCamp.id,  "Copywriter",          600,   8);
  console.log("  Project roles: 26 ensured.");

  // ── Employees ─────────────────────────────────────────────────────────────────
  const max    = await upsertEmployee({ name: "Max Mustermann", email: "max@example.com",    weeklyCapacityHours: 40, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2024-01-01",              utilizationTarget: 80, personalAccessPinHash: hashPin("1234") });
  const anna   = await upsertEmployee({ name: "Anna Beispiel",  email: "anna@example.com",   weeklyCapacityHours: 20, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-06-01",              utilizationTarget: 75, personalAccessPinHash: hashPin("5678") });
  const paul   = await upsertEmployee({ name: "Paul Teilzeit",  email: "paul@example.com",   weeklyCapacityHours: 32, workingDaysMask: "1,1,1,1,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2026-01-15", contractEndDate: "2026-12-31", utilizationTarget: 80, personalAccessPinHash: hashPin("9999") });
  const sophie = await upsertEmployee({ name: "Sophie Wagner",  email: "sophie@example.com", weeklyCapacityHours: 40, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-09-01",              utilizationTarget: 85, personalAccessPinHash: hashPin("2222") });
  const lars   = await upsertEmployee({ name: "Lars König",     email: "lars@example.com",   weeklyCapacityHours: 32, workingDaysMask: "1,1,1,1,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2026-01-01",              utilizationTarget: 80, personalAccessPinHash: hashPin("3333") });
  const mia    = await upsertEmployee({ name: "Mia Fischer",    email: "mia@example.com",    weeklyCapacityHours: 24, workingDaysMask: "1,1,1,0,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-11-01",              utilizationTarget: 75, personalAccessPinHash: hashPin("4444") });
  console.log("  Employees: 6 ensured.");

  // ── Role Assignments (1–3 roles per employee) ─────────────────────────────────
  // Max — frontend / mobile dev
  await upsertAssignment(rAcmeWebFE.id,    max.id);
  await upsertAssignment(rAcmeAppMob.id,   max.id);
  await upsertAssignment(rAcmeAppPM.id,    max.id);

  // Anna — designer / creative (also Creative Director for visibility)
  await upsertAssignment(rBravoIdDes.id,   anna.id);
  await upsertAssignment(rEchoAnaViz.id,   anna.id);
  await upsertAssignment(rBravoCampCS.id,  anna.id);

  // Paul — DevOps / backend
  await upsertAssignment(rAcmeSupOps.id,   paul.id);
  await upsertAssignment(rAcmeWebBE.id,    paul.id);
  await upsertAssignment(rEchoShopOps.id,  paul.id);

  // Sophie — architect / security
  await upsertAssignment(rDeltaErpArch.id, sophie.id);
  await upsertAssignment(rDeltaSecAna.id,  sophie.id);
  await upsertAssignment(rEchoShopBE.id,   sophie.id);

  // Lars — frontend / data engineering
  await upsertAssignment(rEchoShopFE.id,   lars.id);
  await upsertAssignment(rAcmeWebFE.id,    lars.id);
  await upsertAssignment(rEchoAnaDE.id,    lars.id);

  // Mia — QA / support
  await upsertAssignment(rAcmeSupSup.id,   mia.id);
  await upsertAssignment(rEchoShopQA.id,   mia.id);
  await upsertAssignment(rDeltaErpQA.id,   mia.id);

  // Unused roles are seeded for completeness — no employee assignment needed
  void rAcmeWebUX; void rAcmeAppBE; void rDeltaErpBE; void rDeltaSecPen;
  void rEchoAnaBE; void rFoxMigrDA; void rFoxMigrBE; void rBravoCampCW;
  void rBravoIdDir;

  console.log("  Role assignments: 18 ensured.");

  // ── Vacation / Absence Entries (row-level idempotency) ────────────────────────
  let vacInserted = 0;
  async function maybeVacation(employeeId: number, start: string, end: string, type: string, note: string | null) {
    const before = vacInserted;
    await upsertVacation(employeeId, start, end, type, note);
    if (vacInserted === before) vacInserted++; // track only via upsert call
  }
  // Reset counter approach — just count inserts via the upsert helper
  let vacCount = 0;
  async function vacInsert(employeeId: number, start: string, end: string, type: string, note: string | null) {
    const [existing] = await db.select().from(employeeVacationsTable)
      .where(and(
        eq(employeeVacationsTable.employeeId, employeeId),
        eq(employeeVacationsTable.startDate, start),
        eq(employeeVacationsTable.endDate, end),
        eq(employeeVacationsTable.vacationType, type),
      ));
    if (!existing) {
      await db.insert(employeeVacationsTable).values({ employeeId, startDate: start, endDate: end, vacationType: type, note });
      vacCount++;
    }
  }

  await vacInsert(max.id,    "2026-04-21", "2026-04-24", "vacation",     "Easter week break");
  await vacInsert(anna.id,   "2026-05-05", "2026-05-06", "sick",         null);
  await vacInsert(paul.id,   "2026-05-18", "2026-05-22", "vacation",     "Family holiday");
  await vacInsert(sophie.id, "2026-04-07", "2026-04-08", "unpaid_leave", null);
  console.log(`  Vacation entries: ${vacCount} new inserted (4 total expected).`);
  void maybeVacation; // suppress unused warning

  // Vacation date sets (to skip time entry generation on those days)
  const vacMax    = vacationDateSet("2026-04-21", "2026-04-24");
  const vacAnna   = vacationDateSet("2026-05-05", "2026-05-06");
  const vacPaul   = vacationDateSet("2026-05-18", "2026-05-22");
  const vacSophie = vacationDateSet("2026-04-07", "2026-04-08");

  // ── Time Entries (row-level idempotency) ───────────────────────────────────────
  const PERIOD_START = new Date("2026-04-01T00:00:00Z");
  const PERIOD_END   = new Date("2026-06-04T00:00:00Z");

  type EntryRow = {
    employeeId: number;
    projectId: number;
    projectRoleId: number;
    entryDate: string;
    hours: number;
    note: string | null;
    billingStatus: string | null;
    invoiceReference: string | null;
    invoicedAt: Date | null;
  };

  const allEntries: EntryRow[] = [];

  function addEntries(
    wd: Date[],
    employeeId: number,
    dayPatterns: Array<Array<{ pid: number; rid: number; hours: number; note?: string }>>,
  ) {
    wd.forEach((d, i) => {
      const ds    = toIsoDate(d);
      const isApr = ds < "2026-05-01";
      const pattern = dayPatterns[i % dayPatterns.length];
      for (const slot of pattern) {
        allEntries.push({
          employeeId,
          projectId:     slot.pid,
          projectRoleId: slot.rid,
          entryDate:     ds,
          hours:         slot.hours,
          note:          slot.note ?? null,
          billingStatus:    isApr ? "invoiced" : null,
          invoiceReference: isApr ? "INV-2026-04" : null,
          invoicedAt:       isApr ? new Date("2026-05-05T09:00:00Z") : null,
        });
      }
    });
  }

  // Max — 40h/5d = 8h/day (Mon–Fri)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,1,1,0,0", HOLIDAYS, vacMax),
    max.id,
    [
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id, hours: 5, note: "Frontend components" },
       { pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 3 }],
      [{ pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 6, note: "iOS screens" },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 2, note: "Sprint planning" }],
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id, hours: 8, note: "Design review & implementation" }],
      [{ pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 4 },
       { pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 4, note: "Responsive fixes" }],
      [{ pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 5 },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 3, note: "Stakeholder update" }],
    ],
  );

  // Anna — 20h/5d = 4h/day (Mon–Fri)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,1,1,0,0", HOLIDAYS, vacAnna),
    anna.id,
    [
      [{ pid: pBravoId.id,   rid: rBravoIdDes.id,  hours: 3, note: "Logo concepts" },
       { pid: pBravoCamp.id, rid: rBravoCampCS.id,  hours: 1 }],
      [{ pid: pEchoAna.id,  rid: rEchoAnaViz.id,  hours: 2, note: "Dashboard mockups" },
       { pid: pBravoId.id,  rid: rBravoIdDes.id,  hours: 2, note: "Color palette" }],
      [{ pid: pBravoCamp.id, rid: rBravoCampCS.id, hours: 2, note: "Campaign strategy" },
       { pid: pEchoAna.id,  rid: rEchoAnaViz.id,  hours: 2 }],
      [{ pid: pBravoId.id, rid: rBravoIdDes.id, hours: 4, note: "Brand identity delivery" }],
      [{ pid: pBravoCamp.id, rid: rBravoCampCS.id, hours: 2, note: "Creative review" },
       { pid: pEchoAna.id,  rid: rEchoAnaViz.id,  hours: 2 }],
    ],
  );

  // Paul — 32h/4d = 8h/day (Mon–Thu)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,1,0,0,0", HOLIDAYS, vacPaul),
    paul.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 4, note: "Monitoring & alerting" },
       { pid: pAcmeWeb.id,  rid: rAcmeWebBE.id,   hours: 4, note: "API endpoints" }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 5, note: "CI/CD pipeline" },
       { pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 3, note: "Incident response" }],
      [{ pid: pAcmeWeb.id,  rid: rAcmeWebBE.id,   hours: 8, note: "Backend refactor" }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 4, note: "Deployment prep" },
       { pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 4 }],
    ],
  );

  // Sophie — 40h/5d = 8h/day (Mon–Fri)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,1,1,0,0", HOLIDAYS, vacSophie),
    sophie.id,
    [
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 6, note: "Architecture design" },
       { pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 2, note: "Threat modelling" }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 8, note: "Integration layer" }],
      [{ pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 4, note: "Security review" },
       { pid: pEchoShop.id, rid: rEchoShopBE.id,   hours: 4 }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 5 },
       { pid: pEchoShop.id, rid: rEchoShopBE.id,   hours: 3, note: "Checkout API" }],
      [{ pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 4, note: "Pen-test coordination" },
       { pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 4 }],
    ],
  );

  // Lars — 32h/4d = 8h/day (Mon–Thu)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,1,0,0,0", HOLIDAYS, new Set()),
    lars.id,
    [
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 5, note: "Product listing UI" },
       { pid: pAcmeWeb.id,  rid: rAcmeWebFE.id,  hours: 3, note: "Navigation redesign" }],
      [{ pid: pEchoAna.id,  rid: rEchoAnaDE.id,  hours: 6, note: "ETL pipeline" },
       { pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 2 }],
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 8, note: "Cart & checkout flow" }],
      [{ pid: pEchoAna.id,  rid: rEchoAnaDE.id,  hours: 4, note: "Analytics API" },
       { pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 4, note: "Mobile responsive" }],
    ],
  );

  // Mia — 24h/3d = 8h/day (Mon–Wed)
  addEntries(
    workingDays(PERIOD_START, PERIOD_END, "1,1,1,0,0,0,0", HOLIDAYS, new Set()),
    mia.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id,  hours: 4, note: "Support tickets" },
       { pid: pEchoShop.id, rid: rEchoShopQA.id,  hours: 4, note: "Test scenarios" }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpQA.id,  hours: 5, note: "Integration tests" },
       { pid: pEchoShop.id, rid: rEchoShopQA.id,  hours: 3 }],
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id,  hours: 3 },
       { pid: pDeltaErp.id, rid: rDeltaErpQA.id,  hours: 5, note: "Regression suite" }],
    ],
  );

  // Row-level dedup: fetch existing (employeeId, entryDate, projectRoleId) combos
  const empIds = [max.id, anna.id, paul.id, sophie.id, lars.id, mia.id];
  const existingRaw = await db
    .select({
      employeeId:    timeEntriesTable.employeeId,
      entryDate:     timeEntriesTable.entryDate,
      projectRoleId: timeEntriesTable.projectRoleId,
    })
    .from(timeEntriesTable)
    .where(and(
      gte(timeEntriesTable.entryDate, "2026-04-01"),
      lte(timeEntriesTable.entryDate, "2026-06-04"),
      inArray(timeEntriesTable.employeeId, empIds),
    ));

  const existingKeys = new Set(
    existingRaw.map((r) => `${r.employeeId}:${r.entryDate}:${r.projectRoleId ?? "null"}`),
  );

  const toInsert = allEntries.filter(
    (e) => !existingKeys.has(`${e.employeeId}:${e.entryDate}:${e.projectRoleId}`),
  );

  let teInserted = 0;
  if (toInsert.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await db.insert(timeEntriesTable).values(toInsert.slice(i, i + CHUNK));
    }
    teInserted = toInsert.length;
  }

  const aprCount = toInsert.filter((e) => e.entryDate < "2026-05-01").length;
  const mayCount = toInsert.filter((e) => e.entryDate >= "2026-05-01" && e.entryDate < "2026-06-01").length;
  const junCount = toInsert.filter((e) => e.entryDate >= "2026-06-01").length;
  console.log(`  Time entries: ${teInserted} inserted (${existingRaw.length} already existed).`);
  if (teInserted > 0) {
    console.log(`    Apr: ${aprCount} (invoiced) | May: ${mayCount} | Jun: ${junCount}`);
  }

  // ── Resource Bookings (row-level idempotency) ─────────────────────────────────
  let bookingsInserted = 0;
  async function maybeBooking(values: {
    employeeId: number; projectId: number; projectRoleId: number;
    startDate: string; endDate: string; hoursPerDay: number; notes?: string;
  }) {
    const [existing] = await db.select().from(resourceBookingsTable)
      .where(and(
        eq(resourceBookingsTable.employeeId, values.employeeId),
        eq(resourceBookingsTable.projectId, values.projectId),
        eq(resourceBookingsTable.projectRoleId, values.projectRoleId),
        eq(resourceBookingsTable.startDate, values.startDate),
        eq(resourceBookingsTable.endDate, values.endDate),
      ));
    if (!existing) {
      await db.insert(resourceBookingsTable).values(values);
      bookingsInserted++;
    }
  }

  await maybeBooking({ employeeId: max.id, projectId: pAcmeWeb.id, projectRoleId: rAcmeWebFE.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 5, notes: "Frontend delivery" });
  await maybeBooking({ employeeId: max.id, projectId: pAcmeApp.id, projectRoleId: rAcmeAppMob.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 3, notes: "Mobile sprint" });

  await maybeBooking({ employeeId: anna.id, projectId: pBravoId.id, projectRoleId: rBravoIdDes.id,
    startDate: "2026-04-01", endDate: "2026-05-31", hoursPerDay: 2.5, notes: "Brand identity delivery" });
  await maybeBooking({ employeeId: anna.id, projectId: pEchoAna.id, projectRoleId: rEchoAnaViz.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 2, notes: "Dashboard design" });

  await maybeBooking({ employeeId: paul.id, projectId: pAcmeWeb.id, projectRoleId: rAcmeWebBE.id,
    startDate: "2026-04-01", endDate: "2026-05-31", hoursPerDay: 4, notes: "API work" });
  await maybeBooking({ employeeId: paul.id, projectId: pEchoShop.id, projectRoleId: rEchoShopOps.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 4, notes: "Platform ops" });

  await maybeBooking({ employeeId: sophie.id, projectId: pDeltaErp.id, projectRoleId: rDeltaErpArch.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 5.5, notes: "ERP architecture" });
  await maybeBooking({ employeeId: sophie.id, projectId: pDeltaSec.id, projectRoleId: rDeltaSecAna.id,
    startDate: "2026-04-01", endDate: "2026-05-31", hoursPerDay: 3, notes: "Security audit" });

  await maybeBooking({ employeeId: lars.id, projectId: pEchoShop.id, projectRoleId: rEchoShopFE.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 5, notes: "Frontend sprint" });
  await maybeBooking({ employeeId: lars.id, projectId: pEchoAna.id, projectRoleId: rEchoAnaDE.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 3, notes: "Data pipeline" });

  await maybeBooking({ employeeId: mia.id, projectId: pAcmeSup.id, projectRoleId: rAcmeSupSup.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 3.5, notes: "Support coverage" });
  await maybeBooking({ employeeId: mia.id, projectId: pEchoShop.id, projectRoleId: rEchoShopQA.id,
    startDate: "2026-04-01", endDate: "2026-06-04", hoursPerDay: 4.5, notes: "QA testing" });

  console.log(`  Resource bookings: ${bookingsInserted} inserted.`);

  await pool.end();
  console.log("\nSeed complete ✓");
  console.log("  Employees: Max 1234 | Anna 5678 | Paul 9999 | Sophie 2222 | Lars 3333 | Mia 4444");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
