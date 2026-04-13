/**
 * Seed script — run with:
 *   pnpm --filter @workspace/scripts run seed
 *
 * Seeds: 2 clients, 3 projects, 3 employees, holiday calendar (DE-BASE-2026),
 * and sample time entries for the current month.
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
} from "@workspace/db";
import { createHash, randomBytes } from "crypto";
import { eq, and } from "drizzle-orm";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

function hashPin(pin: string): string {
  return createHash("sha256").update(pin).digest("hex");
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Returns the Monday of the current week
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

async function seed() {
  console.log("Seeding database...");

  // ── Holiday Calendar ────────────────────────────────────────────────────
  const [existingCal] = await db
    .select()
    .from(holidayCalendarsTable)
    .where(eq(holidayCalendarsTable.code, "DE-BASE-2026"));

  let calendarId: number;
  if (existingCal) {
    calendarId = existingCal.id;
    console.log("  Holiday calendar already exists, skipping.");
  } else {
    const [cal] = await db
      .insert(holidayCalendarsTable)
      .values({ code: "DE-BASE-2026", name: "Germany Base Public Holidays 2026" })
      .returning();
    calendarId = cal.id;

    const holidays2026 = [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-04-06", name: "Easter Monday" },
      { date: "2026-05-01", name: "Labour Day" },
      { date: "2026-05-14", name: "Ascension Day" },
      { date: "2026-05-25", name: "Whit Monday" },
      { date: "2026-10-03", name: "German Unity Day" },
      { date: "2026-12-25", name: "Christmas Day" },
      { date: "2026-12-26", name: "Second Day of Christmas" },
    ];

    await db.insert(holidaysTable).values(
      holidays2026.map((h) => ({ calendarId, ...h }))
    );
    console.log("  Created DE-BASE-2026 calendar with 9 holidays.");
  }

  // ── Clients ─────────────────────────────────────────────────────────────
  const [existingClient] = await db.select().from(clientsTable);
  if (existingClient) {
    console.log("  Clients already exist, skipping.");
    await pool.end();
    console.log("Seed complete (data already present).");
    return;
  }

  const [acme, bravo] = await db
    .insert(clientsTable)
    .values([
      { name: "Acme Corp", active: true, notes: "Main enterprise client" },
      { name: "Bravo Studios", active: true, notes: "Design retainer client" },
    ])
    .returning();

  console.log("  Created 2 clients.");

  // ── Projects ─────────────────────────────────────────────────────────────
  const [proj1, proj2, proj3] = await db
    .insert(projectsTable)
    .values([
      {
        clientId: acme.id,
        name: "Website Redesign",
        code: "ACME-WEB",
        active: true,
        isBillable: true,
        budgetHours: 200,
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      },
      {
        clientId: acme.id,
        name: "Support & Maintenance",
        code: "ACME-SUP",
        active: true,
        isBillable: true,
        budgetHours: null,
      },
      {
        clientId: bravo.id,
        name: "Brand Identity",
        code: "BRAVO-ID",
        active: true,
        isBillable: false,
        budgetHours: 40,
        startDate: "2026-03-01",
      },
    ])
    .returning();

  console.log("  Created 3 projects.");

  // ── Employees ─────────────────────────────────────────────────────────────
  const employees = await db
    .insert(employeesTable)
    .values([
      {
        name: "Max Mustermann",
        email: "max@example.com",
        weeklyCapacityHours: 40,
        workingDaysMask: "1,1,1,1,1,0,0",
        holidayCalendarCode: "DE-BASE-2026",
        personalAccessToken: generateToken(),
        personalAccessPinHash: hashPin("1234"),
        active: true,
      },
      {
        name: "Anna Beispiel",
        email: "anna@example.com",
        weeklyCapacityHours: 20,
        workingDaysMask: "1,1,1,1,1,0,0",
        holidayCalendarCode: "DE-BASE-2026",
        personalAccessToken: generateToken(),
        personalAccessPinHash: hashPin("5678"),
        active: true,
      },
      {
        name: "Paul Teilzeit",
        email: "paul@example.com",
        weeklyCapacityHours: 32,
        workingDaysMask: "1,1,1,1,0,0,0",
        holidayCalendarCode: "DE-BASE-2026",
        personalAccessToken: generateToken(),
        personalAccessPinHash: hashPin("9999"),
        active: true,
      },
    ])
    .returning();

  const [max, anna, paul] = employees;
  console.log("  Created 3 employees (PIN: 1234 / 5678 / 9999).");

  // ── Sample Time Entries for current month ────────────────────────────────
  const today = new Date();
  const weekStart = getWeekStart(today);

  // Generate entries for the current week only (to avoid overwhelming the seed)
  const entries: {
    employeeId: number;
    projectId: number;
    entryDate: string;
    hours: number;
    note: string | null;
  }[] = [];

  // Max — 8h/day Mon-Fri, mix of projects
  const maxEntries = [
    { dayOffset: 0, hours: 4.5, projectId: proj1.id, note: "Frontend components" },
    { dayOffset: 0, hours: 3.5, projectId: proj2.id, note: null },
    { dayOffset: 1, hours: 8, projectId: proj1.id, note: "Design review" },
    { dayOffset: 2, hours: 5, projectId: proj1.id, note: null },
    { dayOffset: 2, hours: 3, projectId: proj2.id, note: "Bug fix" },
    { dayOffset: 3, hours: 8, projectId: proj1.id, note: null },
    { dayOffset: 4, hours: 7.5, projectId: proj2.id, note: "Client call + fixes" },
  ];

  for (const e of maxEntries) {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + e.dayOffset);
    if (d <= today) {
      entries.push({ employeeId: max.id, projectId: e.projectId, entryDate: toIsoDate(d), hours: e.hours, note: e.note });
    }
  }

  // Anna — 4h/day, part-time
  const annaEntries = [
    { dayOffset: 0, hours: 4, projectId: proj3.id, note: "Mood board" },
    { dayOffset: 1, hours: 4, projectId: proj3.id, note: "Logo concepts" },
    { dayOffset: 2, hours: 2, projectId: proj1.id, note: null },
    { dayOffset: 2, hours: 2, projectId: proj3.id, note: null },
    { dayOffset: 3, hours: 4, projectId: proj3.id, note: "Font pairing" },
  ];

  for (const e of annaEntries) {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + e.dayOffset);
    if (d <= today) {
      entries.push({ employeeId: anna.id, projectId: e.projectId, entryDate: toIsoDate(d), hours: e.hours, note: e.note });
    }
  }

  // Paul — 8h/day Mon-Thu
  const paulEntries = [
    { dayOffset: 0, hours: 8, projectId: proj2.id, note: "Monitoring setup" },
    { dayOffset: 1, hours: 8, projectId: proj1.id, note: "Backend API" },
    { dayOffset: 2, hours: 6, projectId: proj1.id, note: null },
    { dayOffset: 2, hours: 2, projectId: proj2.id, note: null },
    { dayOffset: 3, hours: 8, projectId: proj2.id, note: "Deployment" },
  ];

  for (const e of paulEntries) {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + e.dayOffset);
    if (d <= today) {
      entries.push({ employeeId: paul.id, projectId: e.projectId, entryDate: toIsoDate(d), hours: e.hours, note: e.note });
    }
  }

  if (entries.length > 0) {
    await db.insert(timeEntriesTable).values(entries);
    console.log(`  Created ${entries.length} time entries for current week.`);
  }

  await pool.end();
  console.log("Seed complete.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
