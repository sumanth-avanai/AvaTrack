import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  projectRolesTable,
  projectRoleAssignmentsTable,
  timeEntriesTable,
  resourceBookingsTable,
  employeesTable,
} from "@workspace/db";
import { fetchEmpAvailabilityMap, type EmpAvailability } from "../lib/employee-availability";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count Mon-Fri weekdays in [startStr, endStr] (inclusive), deducting
 * public holidays and employee vacation days.
 */
function countBookableDays(
  startStr: string,
  endStr: string,
  holidayDates: string[] = [],
  vacationDateSet: Set<string> = new Set(),
): number {
  const holidaySet = new Set(holidayDates);
  let count = 0;
  const d = new Date(startStr + "T00:00:00Z");
  const e = new Date(endStr   + "T00:00:00Z");
  while (d <= e) {
    const dow     = d.getUTCDay();
    const dateStr = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr) && !vacationDateSet.has(dateStr)) {
      count++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

/**
 * Fetch holiday + vacation availability for all employees referenced by a
 * list of bookings, covering the union of their date ranges.
 * Returns a Map<employeeId, EmpAvailability> (same shape as fetchEmpAvailabilityMap).
 */
async function getAvailMapForBookings(
  bookings: Array<{ employeeId: number; startDate: string; endDate: string }>,
): Promise<Map<number, EmpAvailability>> {
  if (bookings.length === 0) return new Map();
  const uniqueIds   = [...new Set(bookings.map((b) => b.employeeId))];
  const periodStart = bookings.reduce((m, b) => (b.startDate < m ? b.startDate : m), bookings[0].startDate);
  const periodEnd   = bookings.reduce((m, b) => (b.endDate   > m ? b.endDate   : m), bookings[0].endDate);
  const employees   = await db.select().from(employeesTable).where(inArray(employeesTable.id, uniqueIds));
  return fetchEmpAvailabilityMap(employees, periodStart, periodEnd);
}

// ── Validation schemas ────────────────────────────────────────────────────────
const RoleBodySchema = z.object({
  name: z.string().min(1),
  dayRate: z.number().min(0),
  budgetedDays: z.number().min(0).nullable().optional(),
  budgetedHours: z.number().min(0).nullable().optional(),
  assignedEmployeeIds: z.array(z.number().int()).optional(),
});

const RoleUpdateSchema = RoleBodySchema.partial();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getRolesForProject(projectId: number) {
  const roles = await db
    .select()
    .from(projectRolesTable)
    .where(eq(projectRolesTable.projectId, projectId))
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) return [];

  const roleIds = roles.map((r) => r.id);

  // Fetch all assignments for these roles
  const assignments = await db
    .select({
      projectRoleId: projectRoleAssignmentsTable.projectRoleId,
      employeeId: projectRoleAssignmentsTable.employeeId,
      employeeName: employeesTable.name,
    })
    .from(projectRoleAssignmentsTable)
    .leftJoin(employeesTable, eq(projectRoleAssignmentsTable.employeeId, employeesTable.id))
    .where(
      sql`${projectRoleAssignmentsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
    );

  const assignmentMap = new Map<number, { employeeId: number; employeeName: string | null }[]>();
  for (const a of assignments) {
    if (!assignmentMap.has(a.projectRoleId)) assignmentMap.set(a.projectRoleId, []);
    assignmentMap.get(a.projectRoleId)!.push({ employeeId: a.employeeId, employeeName: a.employeeName ?? null });
  }

  return roles.map((r) => ({
    ...r,
    assignedEmployees: assignmentMap.get(r.id) ?? [],
  }));
}

// ── GET /projects/:projectId/roles ─────────────────────────────────────────
router.get("/projects/:projectId/roles", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  res.json(roles);
});

// ── POST /projects/:projectId/roles ────────────────────────────────────────
router.post("/projects/:projectId/roles", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const parsed = RoleBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { assignedEmployeeIds, ...roleData } = parsed.data;

  const [role] = await db
    .insert(projectRolesTable)
    .values({
      projectId,
      name: roleData.name,
      dayRate: roleData.dayRate,
      budgetedDays: roleData.budgetedDays ?? null,
      budgetedHours: roleData.budgetedHours ?? null,
    })
    .returning();

  // Insert assignments
  if (assignedEmployeeIds && assignedEmployeeIds.length > 0) {
    await db.insert(projectRoleAssignmentsTable).values(
      assignedEmployeeIds.map((employeeId) => ({ projectRoleId: role.id, employeeId }))
    );
  }

  const [enriched] = await getRolesForProject(projectId).then((roles) =>
    roles.filter((r) => r.id === role.id)
  );
  res.status(201).json(enriched);
});

// ── PUT /project-roles/:id ────────────────────────────────────────────────
router.put("/project-roles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = RoleUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { assignedEmployeeIds, ...roleData } = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (roleData.name !== undefined) updateData.name = roleData.name;
  if (roleData.dayRate !== undefined) updateData.dayRate = roleData.dayRate;
  if ("budgetedDays" in roleData) updateData.budgetedDays = roleData.budgetedDays ?? null;
  if ("budgetedHours" in roleData) updateData.budgetedHours = roleData.budgetedHours ?? null;

  let role;
  if (Object.keys(updateData).length > 0) {
    const [updated] = await db
      .update(projectRolesTable)
      .set(updateData)
      .where(eq(projectRolesTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Role not found" }); return; }
    role = updated;
  } else {
    const [found] = await db.select().from(projectRolesTable).where(eq(projectRolesTable.id, id));
    if (!found) { res.status(404).json({ error: "Role not found" }); return; }
    role = found;
  }

  // Replace assignments if provided
  if (assignedEmployeeIds !== undefined) {
    await db.delete(projectRoleAssignmentsTable).where(eq(projectRoleAssignmentsTable.projectRoleId, id));
    if (assignedEmployeeIds.length > 0) {
      await db.insert(projectRoleAssignmentsTable).values(
        assignedEmployeeIds.map((employeeId) => ({ projectRoleId: id, employeeId }))
      );
    }
  }

  const [enriched] = await getRolesForProject(role.projectId).then((roles) =>
    roles.filter((r) => r.id === id)
  );
  res.json(enriched);
});

// ── DELETE /project-roles/:id ─────────────────────────────────────────────
router.delete("/project-roles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [deleted] = await db
    .delete(projectRolesTable)
    .where(eq(projectRolesTable.id, id))
    .returning();

  if (!deleted) { res.status(404).json({ error: "Role not found" }); return; }
  res.sendStatus(204);
});

// ── GET /project-roles/:id/budget-status ───────────────────────────────────
router.get("/project-roles/:id/budget-status", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const excludeBookingId = req.query.excludeBookingId
    ? parseInt(req.query.excludeBookingId as string, 10)
    : null;

  const [role] = await db.select().from(projectRolesTable).where(eq(projectRolesTable.id, id));
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }

  const roleBookings = await db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      employeeName: employeesTable.name,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
    })
    .from(resourceBookingsTable)
    .leftJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .where(eq(resourceBookingsTable.projectRoleId, id));

  const employeeMap = new Map<number, { employeeName: string; days: number }>();
  let totalPlannedDays = 0;

  const availMap = await getAvailMapForBookings(
    roleBookings.filter((b) => excludeBookingId == null || b.id !== excludeBookingId)
  );

  for (const b of roleBookings) {
    if (excludeBookingId != null && b.id === excludeBookingId) continue;
    const avail    = availMap.get(b.employeeId);
    const bookable = countBookableDays(b.startDate, b.endDate, avail?.holidayDates, avail?.vacationDateSet);
    const days = bookable * (b.hoursPerDay / 8);

    totalPlannedDays += days;

    const emp = employeeMap.get(b.employeeId);
    if (emp) {
      emp.days += days;
    } else {
      employeeMap.set(b.employeeId, { employeeName: b.employeeName ?? "Unknown", days });
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  const budgetedDays = role.budgetedDays ?? null;
  const plannedDays = round1(totalPlannedDays);
  const availableDays = budgetedDays != null ? round1(budgetedDays - totalPlannedDays) : null;

  res.json({
    budgetedDays,
    plannedDays,
    availableDays,
    bookings: Array.from(employeeMap.entries())
      .map(([employeeId, { employeeName, days }]) => ({ employeeId, employeeName, days: round1(days) }))
      .sort((a, b) => b.days - a.days),
  });
});

// ── GET /projects/:projectId/budget ────────────────────────────────────────
router.get("/projects/:projectId/budget", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  if (roles.length === 0) {
    res.json({ roles: [], totals: { budgetedDays: 0, budgetedHours: 0, budgetValue: 0, bookedHours: 0, bookedValue: 0 } });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Sum booked hours per role from time_entries
  const bookedRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    )
    .groupBy(timeEntriesTable.projectRoleId);

  // Fetch individual bookings to compute planned days using bookable-day formula:
  // plannedDays = sum over bookings of (bookableDays(minus holidays+vacations) * hoursPerDay / 8)
  const plannedBookings = await db
    .select({
      projectRoleId: resourceBookingsTable.projectRoleId,
      employeeId:    resourceBookingsTable.employeeId,
      startDate:     resourceBookingsTable.startDate,
      endDate:       resourceBookingsTable.endDate,
      hoursPerDay:   resourceBookingsTable.hoursPerDay,
    })
    .from(resourceBookingsTable)
    .where(
      and(
        eq(resourceBookingsTable.projectId, projectId),
        sql`${resourceBookingsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    );

  const bookedMap = new Map<number, number>(bookedRows.map((r) => [r.projectRoleId!, r.totalHours]));

  const plannedAvailMap = await getAvailMapForBookings(plannedBookings);

  // Compute planned hours per role using bookable-day count (holidays + vacations deducted)
  const plannedMap = new Map<number, number>();
  for (const b of plannedBookings) {
    if (b.projectRoleId == null) continue;
    const avail    = plannedAvailMap.get(b.employeeId);
    const bookable = countBookableDays(b.startDate, b.endDate, avail?.holidayDates, avail?.vacationDateSet);
    const hours = bookable * b.hoursPerDay;
    plannedMap.set(b.projectRoleId, (plannedMap.get(b.projectRoleId) ?? 0) + hours);
  }

  let totalBudgetedDays = 0;
  let totalBudgetedHours = 0;
  let totalBudgetValue = 0;
  let totalBookedHours = 0;
  let totalBookedValue = 0;

  const rolesWithBudget = roles.map((role) => {
    const bookedHours = bookedMap.get(role.id) ?? 0;
    const bookedDays = bookedHours / 8;
    const plannedHoursRaw = plannedMap.get(role.id) ?? 0;
    const plannedDays = Math.round((plannedHoursRaw / 8) * 10) / 10;
    const plannedHours = Math.round(plannedHoursRaw * 10) / 10;
    const budgetedDays = role.budgetedDays ?? null;
    const budgetedHours = role.budgetedHours ?? (budgetedDays != null ? budgetedDays * 8 : null);
    const budgetValue = budgetedDays != null ? budgetedDays * role.dayRate : null;
    const bookedValue = bookedDays * role.dayRate;
    const remainingDays = budgetedDays != null ? budgetedDays - bookedDays : null;
    const utilization = budgetedDays != null && budgetedDays > 0 ? bookedDays / budgetedDays : null;

    if (budgetedDays != null) totalBudgetedDays += budgetedDays;
    if (budgetedHours != null) totalBudgetedHours += budgetedHours;
    if (budgetValue != null) totalBudgetValue += budgetValue;
    totalBookedHours += bookedHours;
    totalBookedValue += bookedValue;

    return {
      ...role,
      bookedHours,
      bookedDays,
      plannedHours,
      plannedDays,
      budgetedDays,
      budgetedHours,
      budgetValue,
      bookedValue,
      remainingDays,
      utilization,
    };
  });

  res.json({
    roles: rolesWithBudget,
    totals: {
      budgetedDays: totalBudgetedDays,
      budgetedHours: totalBudgetedHours,
      budgetValue: totalBudgetValue,
      bookedHours: totalBookedHours,
      bookedValue: totalBookedValue,
      remainingDays: totalBudgetedDays - totalBookedHours / 8,
    },
  });
});

// ── GET /projects/:projectId/allocations ───────────────────────────────────
router.get("/projects/:projectId/allocations", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  if (roles.length === 0) {
    res.json({ projectId, roles: [], totals: { budgetedDays: 0, plannedDays: 0, bookedDays: 0, remainingDays: 0, budgetValue: 0, bookedValue: 0 } });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Fetch individual resource bookings for planned-day calculation (per employee per role)
  const bookingRows = await db
    .select({
      projectRoleId: resourceBookingsTable.projectRoleId,
      employeeId: resourceBookingsTable.employeeId,
      employeeName: employeesTable.name,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
    })
    .from(resourceBookingsTable)
    .leftJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .where(
      sql`${resourceBookingsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
    );

  // Fetch time entries booked hours per employee per role
  const timeRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId: timeEntriesTable.employeeId,
      employeeName: employeesTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    )
    .groupBy(timeEntriesTable.projectRoleId, timeEntriesTable.employeeId, employeesTable.name);

  // Build per-role, per-employee allocation map
  // key: `${roleId}:${employeeId}` → { allocatedDays, startDate, endDate, employeeName }
  const round1 = (n: number) => Math.round(n * 10) / 10;

  interface AllocationAccum {
    employeeId: number;
    employeeName: string;
    allocatedDays: number;
    startDate: string;
    endDate: string;
  }
  const allocMap = new Map<string, AllocationAccum>();

  const allocAvailMap = await getAvailMapForBookings(bookingRows.filter((b) => b.projectRoleId != null));

  for (const b of bookingRows) {
    if (b.projectRoleId == null) continue;
    const key      = `${b.projectRoleId}:${b.employeeId}`;
    const avail    = allocAvailMap.get(b.employeeId);
    const bookable = countBookableDays(b.startDate, b.endDate, avail?.holidayDates, avail?.vacationDateSet);
    const days = bookable * (b.hoursPerDay / 8);

    const existing = allocMap.get(key);
    if (existing) {
      existing.allocatedDays += days;
      if (b.startDate < existing.startDate) existing.startDate = b.startDate;
      if (b.endDate > existing.endDate) existing.endDate = b.endDate;
    } else {
      allocMap.set(key, {
        employeeId: b.employeeId,
        employeeName: b.employeeName ?? "Unknown",
        allocatedDays: days,
        startDate: b.startDate,
        endDate: b.endDate,
      });
    }
  }

  // Build per-role, per-employee booked-days map from time entries
  const bookedMap = new Map<string, { employeeId: number; employeeName: string; bookedDays: number }>();
  for (const t of timeRows) {
    if (t.projectRoleId == null) continue;
    const key = `${t.projectRoleId}:${t.employeeId}`;
    bookedMap.set(key, {
      employeeId: t.employeeId,
      employeeName: t.employeeName ?? "Unknown",
      bookedDays: Number(t.totalHours) / 8,
    });
  }

  let totalBudgetedDays = 0;
  let totalPlannedDays = 0;
  let totalBookedDays = 0;
  let totalBudgetValue = 0;
  let totalBookedValue = 0;

  const rolesOut = roles.map((role) => {
    // Collect all employees who appear in either allocations or time entries for this role
    const empIds = new Set<number>();
    for (const [key] of allocMap) {
      const [rId] = key.split(":");
      if (parseInt(rId, 10) === role.id) empIds.add(parseInt(key.split(":")[1], 10));
    }
    for (const [key] of bookedMap) {
      const [rId] = key.split(":");
      if (parseInt(rId, 10) === role.id) empIds.add(parseInt(key.split(":")[1], 10));
    }

    let rolePlannedDays = 0;
    let roleBookedDays = 0;

    const allocations = Array.from(empIds).map((empId) => {
      const aKey = `${role.id}:${empId}`;
      const alloc = allocMap.get(aKey);
      const booked = bookedMap.get(aKey);
      const allocatedDays = round1(alloc?.allocatedDays ?? 0);
      const bookedDays = round1(booked?.bookedDays ?? 0);
      rolePlannedDays += allocatedDays;
      roleBookedDays += bookedDays;
      const percentage = allocatedDays > 0 ? Math.round((bookedDays / allocatedDays) * 100) : 0;
      const employeeName = alloc?.employeeName ?? booked?.employeeName ?? `#${empId}`;
      return {
        employeeId: empId,
        employeeName,
        allocatedDays,
        period: alloc
          ? { start: alloc.startDate, end: alloc.endDate }
          : null,
        bookedDays,
        percentage,
      };
    }).sort((a, b) => b.allocatedDays - a.allocatedDays);

    rolePlannedDays = round1(rolePlannedDays);
    roleBookedDays = round1(roleBookedDays);
    const budgetedDays = role.budgetedDays ?? null;
    const remainingDays = budgetedDays != null ? round1(budgetedDays - rolePlannedDays) : null;
    const budgetValue = budgetedDays != null ? budgetedDays * role.dayRate : null;
    const bookedValue = round1(roleBookedDays * role.dayRate);

    if (budgetedDays != null) totalBudgetedDays += budgetedDays;
    totalPlannedDays += rolePlannedDays;
    totalBookedDays += roleBookedDays;
    if (budgetValue != null) totalBudgetValue += budgetValue;
    totalBookedValue += bookedValue;

    return {
      roleId: role.id,
      roleName: role.name,
      dayRate: role.dayRate,
      budgetedDays,
      plannedDays: rolePlannedDays,
      bookedDays: roleBookedDays,
      remainingDays,
      budgetValue,
      bookedValue,
      allocations,
    };
  });

  res.json({
    projectId,
    roles: rolesOut,
    totals: {
      budgetedDays: round1(totalBudgetedDays),
      plannedDays: round1(totalPlannedDays),
      bookedDays: round1(totalBookedDays),
      remainingDays: round1(totalBudgetedDays - totalPlannedDays),
      budgetValue: round1(totalBudgetValue),
      bookedValue: round1(totalBookedValue),
    },
  });
});

export default router;
