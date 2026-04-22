/**
 * Pivot / flexible report endpoint.
 *
 * GET /api/reports/pivot
 *   startDate        YYYY-MM-DD  (required)
 *   endDate          YYYY-MM-DD  (required)
 *   rowDimension     employees | projects | clients
 *   colDimension     none | month
 *   metric           billable_hours | total_hours |
 *                    billable_utilization_percent | overall_utilization_percent |
 *                    booked_hours | budget_hours | remaining_hours | budget_used_pct
 *   employeeIds      comma-separated IDs  (optional)
 *   projectIds       comma-separated IDs  (optional)
 *   clientIds        comma-separated IDs  (optional)
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray, or } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  employeesTable,
  resourceBookingsTable,
} from "@workspace/db";
import { calculateAvailableHours } from "../lib/utilization";
import { fetchEmpAvailabilityMap } from "../lib/employee-availability";

const router: IRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function parseDateParam(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function parseIds(raw: unknown): number[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  return ids.length > 0 ? ids : undefined;
}

function getMonthsInRange(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  const end = new Date(endDate + "T00:00:00Z");
  const cur = new Date(
    Date.UTC(parseInt(startDate.slice(0, 4)), parseInt(startDate.slice(5, 7)) - 1, 1)
  );
  while (cur <= end) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return months;
}

function monthBounds(yyyymm: string, startDate: string, endDate: string): { start: string; end: string } {
  const year    = parseInt(yyyymm.slice(0, 4));
  const mon     = parseInt(yyyymm.slice(5, 7));
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
  availableHours: number,
  bookedHours: number,
  budgetHours: number | null
): number {
  switch (metric) {
    case "billable_hours":              return billableHours;
    case "total_hours":                 return totalHours;
    case "billable_utilization_percent":
      return availableHours > 0 ? round2(billableHours / availableHours) : 0;
    case "overall_utilization_percent":
      return availableHours > 0 ? round2(totalHours    / availableHours) : 0;
    case "booked_hours":               return bookedHours;
    case "budget_hours":               return budgetHours ?? 0;
    case "remaining_hours":            return budgetHours != null ? round2(budgetHours - totalHours) : 0;
    case "budget_used_pct":            return budgetHours != null && budgetHours > 0 ? round2(totalHours / budgetHours) : 0;
    default: return billableHours;
  }
}

/**
 * Compute the overlapping booked hours between a booking and a date range.
 * Uses the simple formula: overlap_days / 7 * hoursPerWeek
 */
function computeBookedHoursInRange(
  bookingStart: string,
  bookingEnd: string,
  rangeStart: string,
  rangeEnd: string,
  hoursPerWeek: number
): number {
  const overlapStart = bookingStart > rangeStart ? bookingStart : rangeStart;
  const overlapEnd   = bookingEnd   < rangeEnd   ? bookingEnd   : rangeEnd;
  if (overlapStart > overlapEnd) return 0;
  const days = (new Date(overlapEnd).getTime() - new Date(overlapStart).getTime()) / 86400000 + 1;
  return (days / 7) * hoursPerWeek;
}

// ─── main route ─────────────────────────────────────────────────────────────

router.get("/reports/pivot", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rowDimension = String(req.query.rowDimension ?? "employees");
  const colDimension = String(req.query.colDimension ?? "none");
  const metric       = String(req.query.metric       ?? "billable_hours");

  const filterEmpIds  = parseIds(req.query.employeeIds);
  const filterProjIds = parseIds(req.query.projectIds);
  const filterCliIds  = parseIds(req.query.clientIds);

  // ── 1. In-scope projects ─────────────────────────────────────────────────
  const projConds: any[] = [];
  if (filterProjIds) projConds.push(inArray(projectsTable.id, filterProjIds));
  if (filterCliIds)  projConds.push(inArray(projectsTable.clientId, filterCliIds));

  const allProjects = await db
    .select({
      id:          projectsTable.id,
      name:        projectsTable.name,
      clientId:    projectsTable.clientId,
      clientName:  clientsTable.name,
      isBillable:  projectsTable.isBillable,
      budgetHours: projectsTable.budgetHours,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(projConds.length > 0 ? and(...projConds) : undefined);

  const projectById    = new Map(allProjects.map((p) => [p.id, p]));
  const inScopeProjIds = allProjects.map((p) => p.id);

  // ── 2. In-scope employees ────────────────────────────────────────────────
  const empConds: any[] = [eq(employeesTable.active, true)];
  if (filterEmpIds) empConds.push(inArray(employeesTable.id, filterEmpIds));

  const allEmployees = await db
    .select()
    .from(employeesTable)
    .where(and(...empConds));

  // ── 3. Time entries in range ─────────────────────────────────────────────
  const entryConds: any[] = [
    gte(timeEntriesTable.entryDate, startDate),
    lte(timeEntriesTable.entryDate, endDate),
  ];
  if (filterEmpIds)              entryConds.push(inArray(timeEntriesTable.employeeId, filterEmpIds));
  if (inScopeProjIds.length > 0) entryConds.push(inArray(timeEntriesTable.projectId, inScopeProjIds));

  const rawEntries = await db
    .select()
    .from(timeEntriesTable)
    .where(and(...entryConds));

  const entries = rawEntries.map((e) => ({
    ...e,
    isBillable: projectById.get(e.projectId)?.isBillable ?? false,
    clientId:   projectById.get(e.projectId)?.clientId   ?? null,
  }));

  // ── 4. Resource bookings overlapping the date range (for projects/clients) ─
  let bookedHoursByProject = new Map<number, number>();
  if (rowDimension === "projects" || rowDimension === "clients") {
    const bookingConds: any[] = [
      lte(resourceBookingsTable.startDate, endDate),
      gte(resourceBookingsTable.endDate, startDate),
    ];
    if (inScopeProjIds.length > 0) {
      bookingConds.push(inArray(resourceBookingsTable.projectId, inScopeProjIds));
    }
    const bookings = await db
      .select({
        projectId:    resourceBookingsTable.projectId,
        startDate:    resourceBookingsTable.startDate,
        endDate:      resourceBookingsTable.endDate,
        hoursPerWeek: resourceBookingsTable.hoursPerWeek,
      })
      .from(resourceBookingsTable)
      .where(and(...bookingConds));

    for (const b of bookings) {
      const hrs = computeBookedHoursInRange(b.startDate, b.endDate, startDate, endDate, b.hoursPerWeek);
      bookedHoursByProject.set(b.projectId, (bookedHoursByProject.get(b.projectId) ?? 0) + hrs);
    }
  }

  // ── 5. Employee availability (holidays + vacations + contract dates) ──────
  const availMap = await fetchEmpAvailabilityMap(allEmployees, startDate, endDate);

  // ─── CASE A: colDimension = "none"  → flat table ─────────────────────────
  if (colDimension === "none") {
    type FlatRowOut = {
      id: number; label: string;
      availableHours: number; billableHours: number; nonBillableHours: number;
      totalHours: number; billableUtilization: number; overallUtilization: number;
      budgetHours?: number | null;
      bookedHours?: number;
      remainingHours?: number | null;
      budgetUsedPct?: number | null;
    };
    const flatRows: FlatRowOut[] = [];

    if (rowDimension === "employees") {
      for (const emp of allEmployees) {
        const { holidayDates, vacationDateSet } = availMap.get(emp.id)!;
        const available = calculateAvailableHours(
          startDate, endDate,
          emp.workingDaysMask, emp.weeklyCapacityHours,
          holidayDates, vacationDateSet,
          emp.contractStartDate, emp.contractEndDate
        );
        const empEntries = entries.filter((e) => e.employeeId === emp.id);
        const billable   = empEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total      = empEntries.reduce((s, e) => s + e.hours, 0);
        flatRows.push({
          id: emp.id, label: emp.name,
          availableHours:     round2(available),
          billableHours:      round2(billable),
          nonBillableHours:   round2(total - billable),
          totalHours:         round2(total),
          billableUtilization: available > 0 ? round2(billable / available) : 0,
          overallUtilization:  available > 0 ? round2(total    / available) : 0,
        });
      }

    } else if (rowDimension === "projects") {
      for (const proj of allProjects) {
        const projEntries = entries.filter((e) => e.projectId === proj.id);
        const billable    = projEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total       = projEntries.reduce((s, e) => s + e.hours, 0);
        const bookedHrs   = round2(bookedHoursByProject.get(proj.id) ?? 0);
        const budgetHrs   = proj.budgetHours ?? null;
        const remaining   = budgetHrs != null ? round2(budgetHrs - total) : null;
        const budgetUsed  = budgetHrs != null && budgetHrs > 0 ? round2(total / budgetHrs) : null;
        flatRows.push({
          id: proj.id, label: `${proj.name} (${proj.clientName ?? "—"})`,
          availableHours: 0, billableHours: round2(billable),
          nonBillableHours: round2(total - billable), totalHours: round2(total),
          billableUtilization: 0, overallUtilization: 0,
          budgetHours: budgetHrs, bookedHours: bookedHrs,
          remainingHours: remaining, budgetUsedPct: budgetUsed,
        });
      }

    } else if (rowDimension === "clients") {
      const clientMap = new Map<number, {
        id: number; name: string; billable: number; total: number;
        budgetHours: number; hasBudget: boolean; bookedHours: number;
      }>();
      for (const proj of allProjects) {
        if (!proj.clientId) continue;
        if (!clientMap.has(proj.clientId)) {
          clientMap.set(proj.clientId, { id: proj.clientId, name: proj.clientName ?? "—", billable: 0, total: 0, budgetHours: 0, hasBudget: false, bookedHours: 0 });
        }
        const projEntries = entries.filter((e) => e.projectId === proj.id);
        const c = clientMap.get(proj.clientId)!;
        c.billable    += projEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        c.total       += projEntries.reduce((s, e) => s + e.hours, 0);
        if (proj.budgetHours != null) {
          c.budgetHours += proj.budgetHours;
          c.hasBudget = true;
        }
        c.bookedHours += bookedHoursByProject.get(proj.id) ?? 0;
      }
      for (const c of clientMap.values()) {
        const budgetHrs  = c.hasBudget ? c.budgetHours : null;
        const remaining  = budgetHrs != null ? round2(budgetHrs - c.total) : null;
        const budgetUsed = budgetHrs != null && budgetHrs > 0 ? round2(c.total / budgetHrs) : null;
        flatRows.push({
          id: c.id, label: c.name,
          availableHours: 0, billableHours: round2(c.billable),
          nonBillableHours: round2(c.total - c.billable), totalHours: round2(c.total),
          billableUtilization: 0, overallUtilization: 0,
          budgetHours: budgetHrs, bookedHours: round2(c.bookedHours),
          remainingHours: remaining, budgetUsedPct: budgetUsed,
        });
      }
    }

    res.json({ type: "flat", rowDimension, rows: flatRows });
    return;
  }

  // ─── CASE B: colDimension = "month"  → pivot ─────────────────────────────
  const months = getMonthsInRange(startDate, endDate);

  // Pre-compute available hours per employee per month
  const empMonthAvail = new Map<string, number>();
  for (const emp of allEmployees) {
    const { holidayDates, vacationDateSet } = availMap.get(emp.id)!;
    for (const month of months) {
      const { start, end } = monthBounds(month, startDate, endDate);
      const avail = calculateAvailableHours(
        start, end,
        emp.workingDaysMask, emp.weeklyCapacityHours,
        holidayDates, vacationDateSet,
        emp.contractStartDate, emp.contractEndDate
      );
      empMonthAvail.set(`${emp.id}:${month}`, avail);
    }
  }

  // Pre-compute booked hours per project per month (for pivot)
  let bookedHoursByProjectMonth = new Map<string, number>();
  if (rowDimension === "projects" || rowDimension === "clients") {
    const bookingConds: any[] = [
      lte(resourceBookingsTable.startDate, endDate),
      gte(resourceBookingsTable.endDate, startDate),
    ];
    if (inScopeProjIds.length > 0) {
      bookingConds.push(inArray(resourceBookingsTable.projectId, inScopeProjIds));
    }
    const bookings = await db
      .select({
        projectId:    resourceBookingsTable.projectId,
        startDate:    resourceBookingsTable.startDate,
        endDate:      resourceBookingsTable.endDate,
        hoursPerWeek: resourceBookingsTable.hoursPerWeek,
      })
      .from(resourceBookingsTable)
      .where(and(...bookingConds));

    for (const b of bookings) {
      for (const month of months) {
        const { start, end } = monthBounds(month, startDate, endDate);
        const hrs = computeBookedHoursInRange(b.startDate, b.endDate, start, end, b.hoursPerWeek);
        if (hrs > 0) {
          const key = `${b.projectId}:${month}`;
          bookedHoursByProjectMonth.set(key, (bookedHoursByProjectMonth.get(key) ?? 0) + hrs);
        }
      }
    }
  }

  const pivotRows: { id: number; label: string; values: Record<string, number> }[] = [];

  if (rowDimension === "employees") {
    for (const emp of allEmployees) {
      const values: Record<string, number> = {};
      for (const month of months) {
        const monthEntries = entries.filter((e) => e.employeeId === emp.id && e.entryDate.slice(0, 7) === month);
        const billable  = monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total     = monthEntries.reduce((s, e) => s + e.hours, 0);
        const available = empMonthAvail.get(`${emp.id}:${month}`) ?? 0;
        values[month]   = computeMetric(metric, billable, total, available, 0, null);
      }
      pivotRows.push({ id: emp.id, label: emp.name, values });
    }

  } else if (rowDimension === "projects") {
    for (const proj of allProjects) {
      const values: Record<string, number> = {};
      for (const month of months) {
        const monthEntries = entries.filter((e) => e.projectId === proj.id && e.entryDate.slice(0, 7) === month);
        const billable   = monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        const total      = monthEntries.reduce((s, e) => s + e.hours, 0);
        const bookedHrs  = bookedHoursByProjectMonth.get(`${proj.id}:${month}`) ?? 0;
        values[month]    = computeMetric(metric, billable, total, 0, bookedHrs, proj.budgetHours ?? null);
      }
      pivotRows.push({ id: proj.id, label: `${proj.name} (${proj.clientName ?? "—"})`, values });
    }

  } else if (rowDimension === "clients") {
    const clientMonthData = new Map<string, { id: number; name: string; billable: number; total: number; booked: number }>();
    for (const proj of allProjects) {
      if (!proj.clientId) continue;
      for (const month of months) {
        const key = `${proj.clientId}:${month}`;
        if (!clientMonthData.has(key)) clientMonthData.set(key, { id: proj.clientId, name: proj.clientName ?? "—", billable: 0, total: 0, booked: 0 });
        const c = clientMonthData.get(key)!;
        const monthEntries = entries.filter((e) => e.projectId === proj.id && e.entryDate.slice(0, 7) === month);
        c.billable += monthEntries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
        c.total    += monthEntries.reduce((s, e) => s + e.hours, 0);
        c.booked   += bookedHoursByProjectMonth.get(`${proj.id}:${month}`) ?? 0;
      }
    }

    // Compute per-client total budgetHours (sum of project budgets)
    const clientBudgetMap = new Map<number, number | null>();
    for (const proj of allProjects) {
      if (!proj.clientId) continue;
      const cur = clientBudgetMap.get(proj.clientId);
      if (proj.budgetHours != null) {
        clientBudgetMap.set(proj.clientId, (cur ?? 0) + proj.budgetHours);
      } else if (!clientBudgetMap.has(proj.clientId)) {
        clientBudgetMap.set(proj.clientId, null);
      }
    }

    const uniqueClients = new Map<number, string>();
    for (const proj of allProjects) {
      if (proj.clientId) uniqueClients.set(proj.clientId, proj.clientName ?? "—");
    }
    for (const [clientId, clientName] of uniqueClients) {
      const values: Record<string, number> = {};
      const clientBudget = clientBudgetMap.get(clientId) ?? null;
      for (const month of months) {
        const c = clientMonthData.get(`${clientId}:${month}`);
        if (!c) { values[month] = 0; continue; }
        values[month] = computeMetric(metric, c.billable, c.total, 0, c.booked, clientBudget);
      }
      pivotRows.push({ id: clientId, label: clientName, values });
    }
  }

  res.json({ type: "pivot", rowDimension, colDimension, metric, columns: months, rows: pivotRows });
});

export default router;
