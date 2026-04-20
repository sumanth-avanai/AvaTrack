import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  projectRolesTable,
  projectRoleAssignmentsTable,
  timeEntriesTable,
  resourceBookingsTable,
  employeesTable,
} from "@workspace/db";

const router: IRouter = Router();

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
      hoursPerWeek: resourceBookingsTable.hoursPerWeek,
    })
    .from(resourceBookingsTable)
    .leftJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .where(eq(resourceBookingsTable.projectRoleId, id));

  const employeeMap = new Map<number, { employeeName: string; days: number }>();
  let totalPlannedDays = 0;

  for (const b of roleBookings) {
    if (excludeBookingId != null && b.id === excludeBookingId) continue;
    // Calculate planned days: (duration in days incl.) / 7 weeks * hoursPerWeek / 8h per day
    const durationDays =
      (new Date(b.endDate).getTime() - new Date(b.startDate).getTime()) / (1000 * 60 * 60 * 24) + 1;
    const days = (durationDays / 7) * (b.hoursPerWeek / 8);

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

  // Sum planned hours per role from resource_bookings
  // Planned hours = hoursPerWeek * number_of_weeks overlapping booking
  const plannedRows = await db
    .select({
      projectRoleId: resourceBookingsTable.projectRoleId,
      totalHours: sql<number>`COALESCE(SUM(${resourceBookingsTable.hoursPerWeek}), 0)`,
    })
    .from(resourceBookingsTable)
    .where(
      and(
        eq(resourceBookingsTable.projectId, projectId),
        sql`${resourceBookingsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    )
    .groupBy(resourceBookingsTable.projectRoleId);

  const bookedMap = new Map<number, number>(bookedRows.map((r) => [r.projectRoleId!, r.totalHours]));
  const plannedMap = new Map<number, number>(plannedRows.map((r) => [r.projectRoleId!, r.totalHours]));

  let totalBudgetedDays = 0;
  let totalBudgetedHours = 0;
  let totalBudgetValue = 0;
  let totalBookedHours = 0;
  let totalBookedValue = 0;

  const rolesWithBudget = roles.map((role) => {
    const bookedHours = bookedMap.get(role.id) ?? 0;
    const bookedDays = bookedHours / 8;
    const plannedHours = plannedMap.get(role.id) ?? 0;
    const plannedDays = plannedHours / 8;
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

export default router;
