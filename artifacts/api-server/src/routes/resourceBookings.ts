import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
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
      employeeEmail: employeesTable.email,
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
  const { employeeEmail: _email, ...rest } = row;
  return {
    ...rest,
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
const WEEKDAY_KEYS = ["1", "2", "3", "4", "5"] as const;

const WeekdayHoursSchema = z
  .record(z.string(), z.number().min(0).max(24))
  .refine(
    (obj) => obj != null && Object.keys(obj).every((k) => WEEKDAY_KEYS.includes(k as typeof WEEKDAY_KEYS[number])),
    { message: "weekdayHours keys must be ISO weekday strings '1' (Mon) through '5' (Fri)" },
  )
  .nullable()
  .optional();

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

  if (weekdayHours == null && parsed.data.hoursPerDay == null) {
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

  const enriched = enrichRow(rows[0]);

  void (async () => {
    try {
      await db.execute(
        sql`INSERT INTO notification_queue
              (booking_id, employee_email, employee_name, project_name, role_name,
               start_date, end_date, hours_per_day, send_after, sent, updated_at)
            VALUES
              (${enriched.id}, ${rows[0].employeeEmail}, ${rows[0].employeeName}, ${rows[0].projectName},
               ${rows[0].projectRoleName ?? null},
               ${rows[0].startDate}, ${rows[0].endDate}, ${rows[0].hoursPerDay},
               NOW() + INTERVAL '30 minutes', FALSE, NOW())
            ON CONFLICT (employee_email, project_name, booking_id) DO UPDATE
              SET employee_name  = EXCLUDED.employee_name,
                  role_name      = EXCLUDED.role_name,
                  start_date     = EXCLUDED.start_date,
                  end_date       = EXCLUDED.end_date,
                  hours_per_day  = EXCLUDED.hours_per_day,
                  send_after     = NOW() + INTERVAL '30 minutes',
                  sent           = FALSE,
                  updated_at     = NOW()`
      );
    } catch (err) {
      req.log.error({ err }, "notification_queue upsert failed (create booking)");
    }
  })();

  res.status(201).json(enriched);
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

  if (weekdayHours == null && parsed.data.hoursPerDay == null) {
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

  void (async () => {
    try {
      await db.execute(
        sql`INSERT INTO notification_queue
              (booking_id, employee_email, employee_name, project_name, role_name,
               start_date, end_date, hours_per_day, send_after, sent, updated_at)
            VALUES
              (${id}, ${rows[0].employeeEmail}, ${rows[0].employeeName}, ${rows[0].projectName},
               ${rows[0].projectRoleName ?? null},
               ${rows[0].startDate}, ${rows[0].endDate}, ${rows[0].hoursPerDay},
               NOW() + INTERVAL '30 minutes', FALSE, NOW())
            ON CONFLICT (employee_email, project_name, booking_id) DO UPDATE
              SET employee_name  = EXCLUDED.employee_name,
                  role_name      = EXCLUDED.role_name,
                  start_date     = EXCLUDED.start_date,
                  end_date       = EXCLUDED.end_date,
                  hours_per_day  = EXCLUDED.hours_per_day,
                  send_after     = NOW() + INTERVAL '30 minutes',
                  sent           = FALSE,
                  updated_at     = NOW()`
      );
    } catch (err) {
      req.log.error({ err }, "notification_queue upsert failed (update booking)");
    }
  })();

  res.json(enrichRow(rows[0]));
});

// ── DELETE /resource-bookings/:id ─────────────────────────────────────────────
router.delete("/resource-bookings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const preRows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (preRows.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const { employeeEmail, projectName } = preRows[0];

  const result = await db
    .delete(resourceBookingsTable)
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  void (async () => {
    try {
      const deleted = await db.execute(
        sql`DELETE FROM notification_queue
            WHERE booking_id     = ${id}
              AND employee_email = ${employeeEmail}
              AND project_name   = ${projectName}
              AND sent           = FALSE`
      );
      const count = (deleted as { rowCount?: number }).rowCount ?? 0;
      if (count === 0) {
        req.log.info(
          { employeeEmail, projectName, bookingId: id },
          "notification_queue: row already sent or not found — no cleanup needed"
        );
      }
    } catch (err) {
      req.log.error({ err }, "notification_queue cleanup failed (delete booking)");
    }
  })();

  res.json({ success: true });
});

export default router;
