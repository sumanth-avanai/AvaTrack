import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, timeEntriesTable, projectsTable, clientsTable, employeesTable, holidaysTable, holidayCalendarsTable } from "@workspace/db";
import { calculateAvailableHours } from "../lib/utilization";

const router: IRouter = Router();

// Parse and validate a "YYYY-MM-DD" date string from query params.
function parseDateParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

router.get("/reports/utilization", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const employeeIdRaw = req.query.employeeId;
  const employeeId = employeeIdRaw ? parseInt(String(employeeIdRaw), 10) : undefined;

  const employeeFilter = employeeId
    ? and(eq(employeesTable.id, employeeId), eq(employeesTable.active, true))
    : eq(employeesTable.active, true);

  const employees = await db.select().from(employeesTable).where(employeeFilter);

  const results = [];

  for (const emp of employees) {
    // Get holiday dates for this employee's calendar
    let holidayDates: string[] = [];
    if (emp.holidayCalendarCode) {
      const [cal] = await db
        .select()
        .from(holidayCalendarsTable)
        .where(eq(holidayCalendarsTable.code, emp.holidayCalendarCode));

      if (cal) {
        const holidays = await db
          .select({ date: holidaysTable.date })
          .from(holidaysTable)
          .where(eq(holidaysTable.calendarId, cal.id));
        holidayDates = holidays.map((h) => h.date);
      }
    }

    // Calculate available hours — respects capacity, working days mask, and holiday deductions.
    const availableHours = calculateAvailableHours(
      startDate,
      endDate,
      emp.workingDaysMask,
      emp.weeklyCapacityHours,
      holidayDates
    );

    // Fetch time entries for this employee in the period
    const entries = await db
      .select({
        hours: timeEntriesTable.hours,
        isBillable: projectsTable.isBillable,
      })
      .from(timeEntriesTable)
      .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
      .where(
        and(
          eq(timeEntriesTable.employeeId, emp.id),
          gte(timeEntriesTable.entryDate, startDate),
          lte(timeEntriesTable.entryDate, endDate)
        )
      );

    const billableHours = entries.filter((e) => e.isBillable).reduce((sum, e) => sum + e.hours, 0);
    const nonBillableHours = entries.filter((e) => !e.isBillable).reduce((sum, e) => sum + e.hours, 0);
    const totalBookedHours = billableHours + nonBillableHours;

    // Utilization = booked / available (available already accounts for holiday deductions)
    const billableUtilization = availableHours > 0 ? Math.round((billableHours / availableHours) * 1000) / 10 : 0;
    const overallUtilization = availableHours > 0 ? Math.round((totalBookedHours / availableHours) * 1000) / 10 : 0;

    results.push({
      employeeId: emp.id,
      employeeName: emp.name,
      availableHours: Math.round(availableHours * 100) / 100,
      billableHours: Math.round(billableHours * 100) / 100,
      nonBillableHours: Math.round(nonBillableHours * 100) / 100,
      totalBookedHours: Math.round(totalBookedHours * 100) / 100,
      billableUtilization,
      overallUtilization,
    });
  }

  res.json(results);
});

router.get("/reports/projects", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rows = await db
    .select({
      projectId: projectsTable.id,
      projectName: projectsTable.name,
      clientName: clientsTable.name,
      isBillable: projectsTable.isBillable,
      hours: timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      and(
        gte(timeEntriesTable.entryDate, startDate),
        lte(timeEntriesTable.entryDate, endDate)
      )
    );

  const projectMap = new Map<number, { projectId: number; projectName: string; clientName: string; isBillable: boolean; totalHours: number; billableHours: number; nonBillableHours: number }>();

  for (const row of rows) {
    if (!projectMap.has(row.projectId)) {
      projectMap.set(row.projectId, {
        projectId: row.projectId,
        projectName: row.projectName,
        clientName: row.clientName ?? "",
        isBillable: row.isBillable,
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
      });
    }
    const agg = projectMap.get(row.projectId)!;
    agg.totalHours += row.hours;
    if (row.isBillable) {
      agg.billableHours += row.hours;
    } else {
      agg.nonBillableHours += row.hours;
    }
  }

  const result = Array.from(projectMap.values()).map((r) => ({
    ...r,
    totalHours: Math.round(r.totalHours * 100) / 100,
    billableHours: Math.round(r.billableHours * 100) / 100,
    nonBillableHours: Math.round(r.nonBillableHours * 100) / 100,
  }));

  res.json(result);
});

router.get("/reports/clients", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rows = await db
    .select({
      clientId: clientsTable.id,
      clientName: clientsTable.name,
      isBillable: projectsTable.isBillable,
      hours: timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      and(
        gte(timeEntriesTable.entryDate, startDate),
        lte(timeEntriesTable.entryDate, endDate)
      )
    );

  const clientMap = new Map<number, { clientId: number; clientName: string; totalHours: number; billableHours: number; nonBillableHours: number }>();

  for (const row of rows) {
    if (!clientMap.has(row.clientId)) {
      clientMap.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.clientName,
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
      });
    }
    const agg = clientMap.get(row.clientId)!;
    agg.totalHours += row.hours;
    if (row.isBillable) {
      agg.billableHours += row.hours;
    } else {
      agg.nonBillableHours += row.hours;
    }
  }

  const result = Array.from(clientMap.values()).map((r) => ({
    ...r,
    totalHours: Math.round(r.totalHours * 100) / 100,
    billableHours: Math.round(r.billableHours * 100) / 100,
    nonBillableHours: Math.round(r.nonBillableHours * 100) / 100,
  }));

  res.json(result);
});

export default router;
