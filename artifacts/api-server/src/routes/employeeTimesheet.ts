import { Router, type IRouter, type Request } from "express";
import { eq, and, gte, lte, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  projectRolesTable,
  projectRoleAssignmentsTable,
  resourceBookingsTable,
  employeesTable,
} from "@workspace/db";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Token validation helper ───────────────────────────────────────────────────
async function validateEmployeeToken(employeeId: number, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [emp] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.personalAccessToken, token)));
  return !!emp;
}

// ── GET /api/employee-timesheet/:employeeId/week/:weekStart ─────────────────
// Returns available projects (from ProjectRoleAssignment), prefilled rows
// (from active ResourceBookings + existing TimeEntries).
router.get("/employee-timesheet/:employeeId/week/:weekStart", async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const weekStart = req.params.weekStart;
  const token = req.query.token as string | undefined;

  if (isNaN(employeeId) || !DATE_RE.test(weekStart)) {
    res.status(400).json({ error: "Invalid employeeId or weekStart" });
    return;
  }

  // Allow admin session OR valid employee token
  if (!(req as Request & { session?: { appAuthenticated?: boolean } }).session?.appAuthenticated) {
    const valid = await validateEmployeeToken(employeeId, token);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const weekEnd = addDays(weekStart, 6);

  // ── Available projects + roles from ProjectRoleAssignment ─────────────────
  const assignments = await db
    .select({
      projectRoleId: projectRoleAssignmentsTable.projectRoleId,
      roleId: projectRolesTable.id,
      roleName: projectRolesTable.name,
      projectId: projectsTable.id,
      projectName: projectsTable.name,
      clientName: clientsTable.name,
    })
    .from(projectRoleAssignmentsTable)
    .innerJoin(projectRolesTable, eq(projectRoleAssignmentsTable.projectRoleId, projectRolesTable.id))
    .innerJoin(projectsTable, eq(projectRolesTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectRoleAssignmentsTable.employeeId, employeeId))
    .orderBy(projectsTable.name, projectRolesTable.name);

  // Group by project
  const projectMap = new Map<number, {
    projectId: number;
    projectName: string;
    clientName: string | null;
    roles: { roleId: number; roleName: string }[];
  }>();

  for (const row of assignments) {
    if (!projectMap.has(row.projectId)) {
      projectMap.set(row.projectId, {
        projectId: row.projectId,
        projectName: row.projectName,
        clientName: row.clientName ?? null,
        roles: [],
      });
    }
    projectMap.get(row.projectId)!.roles.push({ roleId: row.roleId, roleName: row.roleName });
  }

  const availableProjects = Array.from(projectMap.values());

  // ── Active ResourceBookings for this week ──────────────────────────────────
  const bookings = await db
    .select({
      id: resourceBookingsTable.id,
      projectId: resourceBookingsTable.projectId,
      projectRoleId: resourceBookingsTable.projectRoleId,
      hoursPerWeek: resourceBookingsTable.hoursPerWeek,
      projectName: projectsTable.name,
      clientName: clientsTable.name,
      roleName: projectRolesTable.name,
    })
    .from(resourceBookingsTable)
    .innerJoin(projectsTable, eq(resourceBookingsTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(projectRolesTable, eq(resourceBookingsTable.projectRoleId, projectRolesTable.id))
    .where(
      and(
        eq(resourceBookingsTable.employeeId, employeeId),
        lte(resourceBookingsTable.startDate, weekEnd),
        gte(resourceBookingsTable.endDate, weekStart)
      )
    );

  // ── Existing TimeEntries for this week ────────────────────────────────────
  const entries = await db
    .select({
      projectId: timeEntriesTable.projectId,
      projectRoleId: timeEntriesTable.projectRoleId,
      entryDate: timeEntriesTable.entryDate,
      hours: timeEntriesTable.hours,
      projectName: projectsTable.name,
      clientName: clientsTable.name,
      roleName: projectRolesTable.name,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(projectRolesTable, eq(timeEntriesTable.projectRoleId, projectRolesTable.id))
    .where(
      and(
        eq(timeEntriesTable.employeeId, employeeId),
        gte(timeEntriesTable.entryDate, weekStart),
        lte(timeEntriesTable.entryDate, weekEnd)
      )
    );

  // Build prefilled set: one entry per (project, role) — from bookings first, then existing entries
  // key: "projectId::roleId|null"
  const prefilledMap = new Map<string, {
    projectId: number;
    projectName: string;
    clientName: string | null;
    roleId: number | null;
    roleName: string | null;
    plannedHours: number | null;
    entries: Record<string, number>;
    isLegacy: boolean; // not in ProjectRoleAssignment
  }>();

  // Helper to build key
  const rowKey = (pid: number, rid: number | null) => `${pid}::${rid ?? "null"}`;

  // Set of assigned role combos for legacy detection
  const assignedKeys = new Set<string>();
  for (const a of assignments) {
    assignedKeys.add(rowKey(a.projectId, a.roleId));
  }

  // Add bookings
  for (const b of bookings) {
    const k = rowKey(b.projectId, b.projectRoleId ?? null);
    if (!prefilledMap.has(k)) {
      prefilledMap.set(k, {
        projectId: b.projectId,
        projectName: b.projectName,
        clientName: b.clientName ?? null,
        roleId: b.projectRoleId ?? null,
        roleName: b.roleName ?? null,
        plannedHours: b.hoursPerWeek,
        entries: {},
        isLegacy: !assignedKeys.has(k),
      });
    } else {
      // Accumulate planned hours if multiple bookings for same project/role this week
      const existing = prefilledMap.get(k)!;
      existing.plannedHours = (existing.plannedHours ?? 0) + b.hoursPerWeek;
    }
  }

  // Add existing entries (if not already in prefilledMap from bookings)
  for (const e of entries) {
    const k = rowKey(e.projectId, e.projectRoleId ?? null);
    if (!prefilledMap.has(k)) {
      prefilledMap.set(k, {
        projectId: e.projectId,
        projectName: e.projectName,
        clientName: e.clientName ?? null,
        roleId: e.projectRoleId ?? null,
        roleName: e.roleName ?? null,
        plannedHours: null,
        entries: {},
        isLegacy: !assignedKeys.has(k),
      });
    }
    const dateStr = String(e.entryDate).slice(0, 10);
    prefilledMap.get(k)!.entries[dateStr] = Number(e.hours);
  }

  const prefilled = Array.from(prefilledMap.values()).sort((a, b) =>
    a.projectName.localeCompare(b.projectName) || (a.roleName ?? "").localeCompare(b.roleName ?? "")
  );

  res.json({
    week: { start: weekStart, end: weekEnd },
    availableProjects,
    prefilled,
  });
});

// ── POST /api/employee-timesheet/:employeeId/week/:weekStart ────────────────
// Validate assignment for new entries; grandfather existing entries.
const SaveEntriesBody = z.object({
  entries: z.array(z.object({
    projectId: z.number().int().positive(),
    projectRoleId: z.number().int().positive().nullable().optional(),
    entryDate: z.string().regex(DATE_RE),
    hours: z.number().min(0).max(24),
  })),
});

router.post("/employee-timesheet/:employeeId/week/:weekStart", async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const weekStart = req.params.weekStart;
  const token = req.query.token as string | undefined;

  if (isNaN(employeeId) || !DATE_RE.test(weekStart)) {
    res.status(400).json({ error: "Invalid employeeId or weekStart" });
    return;
  }

  // Allow admin session OR valid employee token
  if (!(req as Request & { session?: { appAuthenticated?: boolean } }).session?.appAuthenticated) {
    const valid = await validateEmployeeToken(employeeId, token);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const weekEnd = addDays(weekStart, 6);

  const parsed = SaveEntriesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { entries } = parsed.data;

  if (entries.length === 0) {
    res.json([]);
    return;
  }

  // Verify employee exists
  const [employee] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));

  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  // ── Grandfather clause: fetch existing entries for this employee/week ──────
  const existingEntries = await db
    .select({
      projectId: timeEntriesTable.projectId,
      projectRoleId: timeEntriesTable.projectRoleId,
      entryDate: timeEntriesTable.entryDate,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.employeeId, employeeId),
        gte(timeEntriesTable.entryDate, weekStart),
        lte(timeEntriesTable.entryDate, weekEnd)
      )
    );

  const existingKeys = new Set<string>(
    existingEntries.map((e) =>
      `${e.projectId}::${e.projectRoleId ?? "null"}::${String(e.entryDate).slice(0, 10)}`
    )
  );

  // ── Fetch all assignments for this employee ───────────────────────────────
  const assignments = await db
    .select({
      projectRoleId: projectRoleAssignmentsTable.projectRoleId,
      projectId: projectRolesTable.projectId,
    })
    .from(projectRoleAssignmentsTable)
    .innerJoin(projectRolesTable, eq(projectRoleAssignmentsTable.projectRoleId, projectRolesTable.id))
    .where(eq(projectRoleAssignmentsTable.employeeId, employeeId));

  const assignedRoleIds = new Set<number>(assignments.map((a) => a.projectRoleId));

  // ── Validate each new entry ───────────────────────────────────────────────
  for (const entry of entries) {
    if (entry.hours === 0) continue; // deletions always allowed

    const entryKey = `${entry.projectId}::${entry.projectRoleId ?? "null"}::${entry.entryDate}`;
    if (existingKeys.has(entryKey)) continue; // grandfather: existing entry, allow

    // New entry — must have assignment
    const roleId = entry.projectRoleId ?? null;
    if (roleId !== null && !assignedRoleIds.has(roleId)) {
      res.status(403).json({
        error: "Not assigned to this project role",
        projectId: entry.projectId,
        projectRoleId: roleId,
      });
      return;
    }
  }

  // ── Bulk upsert ───────────────────────────────────────────────────────────
  const results: (typeof timeEntriesTable.$inferSelect)[] = [];

  for (const item of entries) {
    const projectRoleId = item.projectRoleId ?? null;
    if (item.hours < 0 || item.hours > 24) continue;

    const roleCondition = projectRoleId != null
      ? eq(timeEntriesTable.projectRoleId, projectRoleId)
      : isNull(timeEntriesTable.projectRoleId);

    const [existing] = await db
      .select()
      .from(timeEntriesTable)
      .where(
        and(
          eq(timeEntriesTable.employeeId, employeeId),
          eq(timeEntriesTable.projectId, item.projectId),
          roleCondition,
          eq(timeEntriesTable.entryDate, item.entryDate)
        )
      );

    if (existing) {
      if (item.hours === 0) {
        await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, existing.id));
      } else {
        const [updated] = await db
          .update(timeEntriesTable)
          .set({ hours: item.hours })
          .where(eq(timeEntriesTable.id, existing.id))
          .returning();
        results.push(updated);
      }
    } else if (item.hours > 0) {
      const [created] = await db
        .insert(timeEntriesTable)
        .values({
          employeeId,
          projectId: item.projectId,
          projectRoleId,
          entryDate: item.entryDate,
          hours: item.hours,
        })
        .returning();
      results.push(created);
    }
  }

  res.json(results);
});

export default router;
