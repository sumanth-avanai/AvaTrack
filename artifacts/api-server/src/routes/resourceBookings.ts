import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  resourceBookingsTable,
  employeesTable,
  projectsTable,
  clientsTable,
  projectRolesTable,
} from "@workspace/db";
import { resolveProjectColor } from "@workspace/api-zod";

const router: IRouter = Router();

// ── Shared SELECT query ───────────────────────────────────────────────────────
function buildSelect() {
  return db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      projectId: resourceBookingsTable.projectId,
      projectRoleId: resourceBookingsTable.projectRoleId,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
      weekdayHours: resourceBookingsTable.weekdayHours,
      notes: resourceBookingsTable.notes,
      createdAt: resourceBookingsTable.createdAt,
      updatedAt: resourceBookingsTable.updatedAt,
      employeeName: employeesTable.name,
      weeklyCapacityHours: employeesTable.weeklyCapacityHours,
      projectName: projectsTable.name,
      projectColor: projectsTable.color,
      clientName: clientsTable.name,
      projectRoleName: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
    })
    .from(resourceBookingsTable)
    .innerJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .innerJoin(projectsTable, eq(resourceBookingsTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(projectRolesTable, eq(resourceBookingsTable.projectRoleId, projectRolesTable.id));
}

function enrichRow(row: Awaited<ReturnType<typeof buildSelect>>[number]) {
  return {
    ...row,
    projectColor: resolveProjectColor(row.projectId, row.projectColor),
  };
}

// ── GET /resource-bookings ────────────────────────────────────────────────────
router.get("/resource-bookings", async (req, res): Promise<void> => {
  const { employeeId, startDate, endDate } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (employeeId) {
    const empId = parseInt(employeeId, 10);
    if (!isNaN(empId)) conditions.push(eq(resourceBookingsTable.employeeId, empId));
  }
  if (startDate) conditions.push(gte(resourceBookingsTable.endDate, startDate));
  if (endDate) conditions.push(lte(resourceBookingsTable.startDate, endDate));

  const rows = await buildSelect()
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(resourceBookingsTable.startDate);

  res.json(rows.map(enrichRow));
});

// ── Validation schema ─────────────────────────────────────────────────────────
const WeekdayHoursSchema = z.record(z.string(), z.number().min(0).max(24)).nullable().optional();

const BookingBodySchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  projectRoleId: z.number().int().positive().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursPerDay: z.number().min(0).optional(),
  weekdayHours: WeekdayHoursSchema,
  notes: z.string().optional().nullable(),
});

/** Resolve effective hoursPerDay from input: weekday sum÷5 or flat value. */
function resolveHoursPerDay(
  hoursPerDay: number | undefined,
  weekdayHours: Record<string, number> | null | undefined,
): number {
  if (weekdayHours != null) {
    const sum = Object.values(weekdayHours).reduce((a, b) => a + b, 0);
    return sum / 5;
  }
  return hoursPerDay ?? 0;
}

// ── POST /resource-bookings ───────────────────────────────────────────────────
router.post("/resource-bookings", async (req, res): Promise<void> => {
  const parsed = BookingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { employeeId, projectId, projectRoleId, startDate, endDate, notes } = parsed.data;
  const weekdayHours = parsed.data.weekdayHours ?? null;

  if (weekdayHours == null && !parsed.data.hoursPerDay) {
    res.status(400).json({ error: "Either hoursPerDay or weekdayHours must be provided" });
    return;
  }

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const hoursPerDay = resolveHoursPerDay(parsed.data.hoursPerDay, weekdayHours);

  const [inserted] = await db
    .insert(resourceBookingsTable)
    .values({
      employeeId,
      projectId,
      projectRoleId: projectRoleId ?? null,
      startDate,
      endDate,
      hoursPerDay,
      weekdayHours: weekdayHours ?? undefined,
      notes: notes ?? null,
    })
    .returning({ id: resourceBookingsTable.id });

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, inserted.id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve created booking" }); return; }
  res.status(201).json(enrichRow(rows[0]));
});

// ── PUT /resource-bookings/:id ────────────────────────────────────────────────
router.put("/resource-bookings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const parsed = BookingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { employeeId, projectId, projectRoleId, startDate, endDate, notes } = parsed.data;
  const weekdayHours = parsed.data.weekdayHours ?? null;

  if (weekdayHours == null && !parsed.data.hoursPerDay) {
    res.status(400).json({ error: "Either hoursPerDay or weekdayHours must be provided" });
    return;
  }

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const hoursPerDay = resolveHoursPerDay(parsed.data.hoursPerDay, weekdayHours);

  const result = await db
    .update(resourceBookingsTable)
    .set({
      employeeId,
      projectId,
      projectRoleId: projectRoleId ?? null,
      startDate,
      endDate,
      hoursPerDay,
      weekdayHours: weekdayHours ?? null,
      notes: notes ?? null,
    })
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve updated booking" }); return; }
  res.json(enrichRow(rows[0]));
});

// ── DELETE /resource-bookings/:id ─────────────────────────────────────────────
router.delete("/resource-bookings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const result = await db
    .delete(resourceBookingsTable)
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }
  res.json({ success: true });
});

export default router;
