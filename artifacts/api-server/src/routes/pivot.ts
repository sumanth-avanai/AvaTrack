/**
 * Pivot / flexible report endpoint.
 *
 * GET /api/reports/pivot
 *   startDate        YYYY-MM-DD  (required)
 *   endDate          YYYY-MM-DD  (required)
 *   rowDimension     employees | projects | clients
 *   colDimension     none | month
 *   metric           billable_hours | total_hours |
 *                    billable_utilization_percent | overall_utilization_percent
 *   employeeIds      comma-separated IDs  (optional filter)
 *   projectIds       comma-separated IDs  (optional filter)
 *   clientIds        comma-separated IDs  (optional filter)
 *
 * Response (colDimension=none):
 *   { type:"flat", rows:[{id,label,availableHours,billableHours,nonBillableHours,totalHours,billableUtilization,overallUtilization}] }
 *
 * Response (colDimension=month):
 *   { type:"pivot", columns:["2026-01",...], rows:[{id,label,values:{"2026-01":number}}] }
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  employeesTable,
  holidaysTable,
  holidayCalendarsTable,
} from "@workspace/db";
import { calculateAvailableHours } from "../lib/utilization";

const router: IRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function parseDateParam(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function parseIds(raw: unknown): number[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
  return ids.length > 0 ? ids : undefined;
}

/** All YYYY-MM strings that overlap with [startDate, endDate]. */
function getMonthsInRange(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  const end = new Date(endDate + "T00:00:00Z");
  const cur = new Date(
    Date.UTC(
      parseInt(startDate.slice(0, 4)),
      parseInt(startDate.slice(5, 7)) - 1,
      1
    )
  );
  while (cur <= end) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return months;
}

/** Clamp a month's first/last day to [startDate, endDate]. */
function monthBounds(
  yyyymm: string,
  startDate: string,
  endDate: string
): { start: string; end: string } {
  const year = parseInt(yyyymm.slice(0, 4));
  const mon  = parseInt(yyyymm.slice(5, 7));
  const monthFirst = `${yyyymm}-01`;
  const lastDay    = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const monthLast  = `${yyyymm}-${String(lastDay).padStart(2, "0")}`;
  return {
    start: monthFirst < startDate ? startDate : monthFirst,
    end:   monthLast  > endDate   ? endDate   : monthLast,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function computeMetric(
  metric: string,
  billableHours: number,
  totalHours: number,
  availableHours: number
): number {
  switch (metric) {
    case "billable_hours":             return billableHours;
    case "total_hours":                return totalHours;
    case "billable_utilization_percent":
      return availableHours > 0 ? round2(billableHours / availableHours) : 0;
    case "overall_utilization_percent":
      return availableHours > 0 ? round2(totalHours / availableHours) : 0;
    default: return billableHours;
  }
}

// ─── holiday cache ───────────────────────────────────────────────────────────

async function buildHolidayMap(employees: (typeof employeesTable.$inferSelect)[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();

  // Group by calendar code to avoid redundant DB queries
  const calendarCodeToHolidays = new Map<string, string[]>();

  for (const emp of employees) {
    if (emp.holidayCalendarCode && !calendarCodeToHolidays.has(emp.holidayCalendarCode)) {
      const [cal] = await db
        .select()
        .from(holidayCalendarsTable)
        .where(eq(holidayCalendarsTable.code, emp.holidayCalendarCode));

      if (cal) {
        const rows = await db
          .select({ date: holidaysTable.date })
          .from(holidaysTable)
          .where(eq(holidaysTable.calendarId, cal.id));
        calendarCodeToHolidays.set(emp.holidayCalendarCode, rows.map((r) => r.date));
      } else {
        calendarCodeToHolidays.set(emp.holidayCalendarCode, []);
      }
    }
    map.set(emp.id, emp.holidayCalendarCode ? (calendarCodeToHolidays.get(emp.holidayCalendarCode) ?? []) : []);
  }

  return map;
}

// ─── main route ─────────────────────────────────────────────────────────────

router.get("/reports/pivot", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rowDimension = String(req.query.rowDimension  ?? "employees");
  const colDimension = String(req.query.colDimension  ?? "none");
  const metric       = String(req.query.metric        ?? "billable_hours");

  const filterEmpIds  = parseIds(req.query.employeeIds);
  const filterProjIds = parseIds(req.query.projectIds);
  const filterCliIds  = parseIds(req.query.clientIds);

  // ── 1. Resolve in-scope projects ──────────────────────────────────────────
  const projConds: ReturnType<typeof eq>[] = [];
  if (filterProjIds) projConds.push(inArray(projectsTable.id, filterProjIds) as any);
  if (filterCliIds)  projConds.push(inArray(projectsTable.clientId, filterCliIds) as any);

  const allProjects = await db
    .select({
      id:         projectsTable.id,
      name:       projectsTable.name,
      clientId:   projectsTable.clientId,
      clientName: clientsTable.name,
      isBillable: projectsTable.isBillable,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(projConds.length > 0 ? and(...(projConds as any)) : undefined);

  const projectById = new Map(allProjects.map((p) => [p.id, p]));
  const inScopeProjIds = allProjects.map((p) => p.id);

  // ── 2. Resolve in-scope employees ─────────────────────────────────────────
  const empConds: ReturnType<typeof eq>[] = [eq(employeesTable.active, true) as any];
  if (filterEmpIds) empConds.push(inArray(employeesTable.id, filterEmpIds) as any);

  const allEmployees = await db
    .select()
    .from(employeesTable)
    .where(and(...(empConds as any)));

  const employeeById = new Map(allEmployees.map((e) => [e.id, e]));

  // ── 3. Fetch time entries in range ────────────────────────────────────────
  const entryConds: ReturnType<typeof eq>[] = [
    gte(timeEntriesTable.entryDate, startDate) as any,
    lte(timeEntriesTable.entryDate, endDate)   as any,
  ];
  if (filterEmpIds)       entryConds.push(inArray(timeEntriesTable.employeeId, filterEmpIds) as any);
  if (inScopeProjIds.length > 0) entryConds.push(inArray(timeEntriesTable.projectId, inScopeProjIds) as any);

  const rawEntries = await db
    .select()
    .from(timeEntriesTable)
    .where(and(...(entryConds as any)));

  // Annotate entries with billable flag
  const entries = rawEntries.map((e) => ({
    ...e,
    isBillable: projectById.get(e.projectId)?.isBillable ?? false,
    clientId:   projectById.get(e.projectId)?.clientId   ?? null,
  }));

  // ── 4. Build holiday map for utilization ──────────────────────────────────
  const holidayMap = await buildHolidayMap(allEmployees);

  // ─────────────────────────────────────────────────────────────────────────
  // CASE A: colDimension = "none"  → flat summary table
  // ─────────────────────────────────────────────────────────────────────────
  if (colDimension === "none") {
    const flatRows: {
      id: number;
      label: string;
      availableHours: number;
      billableHours: number;
      nonBillableHours: number;
      totalHours: number;
      billableUtilization: number;
      overallUtilization: number;
    }[] = [];

    if (rowDimension === "employees") {
      for (const emp of allEmployees) {
        const empEntries = entries.filter((e) => e.employeeId === emp.id);
        const billable   = empEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total      = empEntries.reduce((s, e) => s + e.hours, 0);
        const available  = calculateAvailableHours(startDate, endDate, emp.workingDaysMask, emp.weeklyCapacityHours, holidayMap.get(emp.id) ?? []);

        flatRows.push({
          id:    emp.id,
          label: emp.name,
          availableHours:     round2(available),
          billableHours:      round2(billable),
          nonBillableHours:   round2(total - billable),
          totalHours:         round2(total),
          billableUtilization: available > 0 ? round2(billable / available) : 0,
          overallUtilization:  available > 0 ? round2(total   / available) : 0,
        });
      }

    } else if (rowDimension === "projects") {
      for (const proj of allProjects) {
        const projEntries = entries.filter((e) => e.projectId === proj.id);
        const billable    = projEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total       = projEntries.reduce((s, e) => s + e.hours, 0);

        flatRows.push({
          id:    proj.id,
          label: `${proj.name} (${proj.clientName ?? "—"})`,
          availableHours:     0,
          billableHours:      round2(billable),
          nonBillableHours:   round2(total - billable),
          totalHours:         round2(total),
          billableUtilization: 0,
          overallUtilization:  0,
        });
      }

    } else if (rowDimension === "clients") {
      const clientMap = new Map<number, { id: number; name: string; billable: number; total: number }>();
      for (const proj of allProjects) {
        if (!proj.clientId) continue;
        if (!clientMap.has(proj.clientId)) {
          clientMap.set(proj.clientId, { id: proj.clientId, name: proj.clientName ?? "—", billable: 0, total: 0 });
        }
        const projEntries = entries.filter((e) => e.projectId === proj.id);
        const c = clientMap.get(proj.clientId)!;
        c.billable += projEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        c.total    += projEntries.reduce((s, e) => s + e.hours, 0);
      }

      for (const c of clientMap.values()) {
        flatRows.push({
          id:    c.id,
          label: c.name,
          availableHours:     0,
          billableHours:      round2(c.billable),
          nonBillableHours:   round2(c.total - c.billable),
          totalHours:         round2(c.total),
          billableUtilization: 0,
          overallUtilization:  0,
        });
      }
    }

    res.json({ type: "flat", rowDimension, rows: flatRows });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CASE B: colDimension = "month"  → pivot table
  // ─────────────────────────────────────────────────────────────────────────
  const months = getMonthsInRange(startDate, endDate);

  // Pre-compute available hours per employee per month (clamped to date range)
  const empMonthAvailable = new Map<string, number>(); // key = `${empId}:${yyyymm}`
  for (const emp of allEmployees) {
    for (const month of months) {
      const { start, end } = monthBounds(month, startDate, endDate);
      const avail = calculateAvailableHours(start, end, emp.workingDaysMask, emp.weeklyCapacityHours, holidayMap.get(emp.id) ?? []);
      empMonthAvailable.set(`${emp.id}:${month}`, avail);
    }
  }

  const pivotRows: { id: number; label: string; values: Record<string, number> }[] = [];

  if (rowDimension === "employees") {
    for (const emp of allEmployees) {
      const values: Record<string, number> = {};
      for (const month of months) {
        const monthEntries = entries.filter(
          (e) => e.employeeId === emp.id && e.entryDate.slice(0, 7) === month
        );
        const billable  = monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total     = monthEntries.reduce((s, e) => s + e.hours, 0);
        const available = empMonthAvailable.get(`${emp.id}:${month}`) ?? 0;
        values[month]   = computeMetric(metric, billable, total, available);
      }
      pivotRows.push({ id: emp.id, label: emp.name, values });
    }

  } else if (rowDimension === "projects") {
    for (const proj of allProjects) {
      const values: Record<string, number> = {};
      for (const month of months) {
        const monthEntries = entries.filter(
          (e) => e.projectId === proj.id && e.entryDate.slice(0, 7) === month
        );
        const billable = monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total    = monthEntries.reduce((s, e) => s + e.hours, 0);
        // For projects: utilization metrics treated as total/billable hours (no capacity)
        values[month]  = computeMetric(metric, billable, total, 0);
      }
      pivotRows.push({ id: proj.id, label: `${proj.name} (${proj.clientName ?? "—"})`, values });
    }

  } else if (rowDimension === "clients") {
    const clientMonthData = new Map<string, { id: number; name: string; billable: number; total: number }>();
    // Populate
    for (const proj of allProjects) {
      if (!proj.clientId) continue;
      for (const month of months) {
        const key = `${proj.clientId}:${month}`;
        if (!clientMonthData.has(key)) {
          clientMonthData.set(key, { id: proj.clientId, name: proj.clientName ?? "—", billable: 0, total: 0 });
        }
        const c = clientMonthData.get(key)!;
        const monthEntries = entries.filter(
          (e) => e.projectId === proj.id && e.entryDate.slice(0, 7) === month
        );
        c.billable += monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        c.total    += monthEntries.reduce((s, e) => s + e.hours, 0);
      }
    }

    // Collect unique clients from allProjects
    const uniqueClients = new Map<number, string>();
    for (const proj of allProjects) {
      if (proj.clientId) uniqueClients.set(proj.clientId, proj.clientName ?? "—");
    }

    for (const [clientId, clientName] of uniqueClients) {
      const values: Record<string, number> = {};
      for (const month of months) {
        const c = clientMonthData.get(`${clientId}:${month}`);
        values[month] = c ? computeMetric(metric, c.billable, c.total, 0) : 0;
      }
      pivotRows.push({ id: clientId, label: clientName, values });
    }
  }

  res.json({ type: "pivot", rowDimension, colDimension, metric, columns: months, rows: pivotRows });
});

export default router;
