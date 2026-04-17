import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  resourceBookingsTable,
  employeesTable,
  projectsTable,
  clientsTable,
} from "@workspace/db";

const router: IRouter = Router();

// ── Color palette (matches frontend) ─────────────────────────────────────────
const PROJECT_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#3b82f6", "#ec4899",
  "#8b5cf6", "#f97316", "#14b8a6", "#ef4444", "#84cc16",
  "#06b6d4", "#a855f7", "#d946ef", "#0ea5e9", "#22c55e",
  "#fb923c", "#e11d48", "#7c3aed", "#2563eb", "#059669",
];
function resolveColor(projectId: number, storedColor: string | null): string {
  return storedColor ?? PROJECT_COLORS[projectId % PROJECT_COLORS.length];
}

// ── Shared SELECT query ───────────────────────────────────────────────────────
function buildSelect() {
  return db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      projectId: resourceBookingsTable.projectId,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerWeek: resourceBookingsTable.hoursPerWeek,
      notes: resourceBookingsTable.notes,
      createdAt: resourceBookingsTable.createdAt,
      updatedAt: resourceBookingsTable.updatedAt,
      employeeName: employeesTable.name,
      weeklyCapacityHours: employeesTable.weeklyCapacityHours,
      projectName: projectsTable.name,
      projectColor: projectsTable.color,
      clientName: clientsTable.name,
    })
    .from(resourceBookingsTable)
    .innerJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .innerJoin(projectsTable, eq(resourceBookingsTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id));
}

function enrichRow(row: Awaited<ReturnType<typeof buildSelect>>[number]) {
  return {
    ...row,
    projectColor: resolveColor(row.projectId, row.projectColor),
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
const BookingBodySchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursPerWeek: z.number().positive(),
  notes: z.string().optional().nullable(),
});

// ── POST /resource-bookings ───────────────────────────────────────────────────
router.post("/resource-bookings", async (req, res): Promise<void> => {
  const parsed = BookingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { employeeId, projectId, startDate, endDate, hoursPerWeek, notes } = parsed.data;

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const [inserted] = await db
    .insert(resourceBookingsTable)
    .values({ employeeId, projectId, startDate, endDate, hoursPerWeek, notes: notes ?? null })
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

  const { employeeId, projectId, startDate, endDate, hoursPerWeek, notes } = parsed.data;

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const result = await db
    .update(resourceBookingsTable)
    .set({ employeeId, projectId, startDate, endDate, hoursPerWeek, notes: notes ?? null })
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
