/**
 * GET  /api/projects/:id/billing?startDate=&endDate=
 *   Returns logged vs invoiced revenue per role and employee for a project.
 *
 * POST /api/time-entries/mark-invoiced
 *   Stamps all matching unbilled time entries with invoiced_at = NOW()
 *   and an optional invoice_reference.
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  projectsTable,
  projectRolesTable,
  timeEntriesTable,
  employeesTable,
} from "@workspace/db";

const router: IRouter = Router();

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v: unknown): string | null {
  return typeof v === "string" && dateRe.test(v) ? v : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── GET /projects/:projectId/billing ────────────────────────────────────────

router.get("/projects/:projectId/billing", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const startDate = parseDate(req.query.startDate);
  const endDate   = parseDate(req.query.endDate);

  // Fetch the project
  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Fetch all roles for the project
  const roles = await db
    .select({
      id: projectRolesTable.id,
      name: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
      budgetedDays: projectRolesTable.budgetedDays,
    })
    .from(projectRolesTable)
    .where(eq(projectRolesTable.projectId, projectId))
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) {
    res.json({
      project,
      totals: { budget: 0, logged: 0, invoiced: 0, unbilled: 0, remaining: 0 },
      roles: [],
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Build date conditions for time entries
  const entryConditions = [
    eq(timeEntriesTable.projectId, projectId),
    sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
  ];
  if (startDate) entryConditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   entryConditions.push(lte(timeEntriesTable.entryDate, endDate));

  // Aggregate hours per (roleId, employeeId), split invoiced vs total
  const entryRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId:    timeEntriesTable.employeeId,
      employeeName:  employeesTable.name,
      totalHours:    sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(and(...entryConditions))
    .groupBy(
      timeEntriesTable.projectRoleId,
      timeEntriesTable.employeeId,
      employeesTable.name,
    );

  // Index by roleId
  type EmpRow = { employeeId: number; employeeName: string; totalHours: number; invoicedHours: number };
  const byRole = new Map<number, EmpRow[]>();
  for (const row of entryRows) {
    if (row.projectRoleId == null) continue;
    if (!byRole.has(row.projectRoleId)) byRole.set(row.projectRoleId, []);
    byRole.get(row.projectRoleId)!.push({
      employeeId:    row.employeeId,
      employeeName:  row.employeeName ?? `#${row.employeeId}`,
      totalHours:    Number(row.totalHours),
      invoicedHours: Number(row.invoicedHours),
    });
  }

  let totalBudget    = 0;
  let totalLogged    = 0;
  let totalInvoiced  = 0;

  const rolesOut = roles.map((role) => {
    const empRows = byRole.get(role.id) ?? [];
    const dayRate = role.dayRate;

    const employees = empRows
      .map((e) => {
        const loggedHours    = e.totalHours;
        const invoicedHours  = e.invoicedHours;
        const logged         = round2((loggedHours / 8) * dayRate);
        const invoiced       = round2((invoicedHours / 8) * dayRate);
        const unbilled       = round2(logged - invoiced);
        return { id: e.employeeId, name: e.employeeName, loggedHours, logged, invoicedHours, invoiced, unbilled };
      })
      .sort((a, b) => b.logged - a.logged);

    const roleLoggedHours   = employees.reduce((s, e) => s + e.loggedHours,   0);
    const roleInvoicedHours = employees.reduce((s, e) => s + e.invoicedHours, 0);
    const logged            = round2((roleLoggedHours / 8) * dayRate);
    const invoiced          = round2((roleInvoicedHours / 8) * dayRate);
    const unbilled          = round2(logged - invoiced);
    const budget            = role.budgetedDays != null ? round2(role.budgetedDays * dayRate) : null;
    const remaining         = budget != null ? round2(budget - logged) : null;

    if (budget != null) totalBudget += budget;
    totalLogged   += logged;
    totalInvoiced += invoiced;

    return {
      id:          role.id,
      name:        role.name,
      dayrate:     dayRate,
      budgetedDays: role.budgetedDays,
      budget,
      loggedHours: round2(roleLoggedHours),
      logged,
      invoicedHours: round2(roleInvoicedHours),
      invoiced,
      unbilled,
      remaining,
      employees,
    };
  });

  const totalUnbilled  = round2(totalLogged - totalInvoiced);
  const totalRemaining = round2(totalBudget - totalLogged);

  res.json({
    project,
    totals: {
      budget:    round2(totalBudget),
      logged:    round2(totalLogged),
      invoiced:  round2(totalInvoiced),
      unbilled:  totalUnbilled,
      remaining: totalRemaining,
    },
    roles: rolesOut,
  });
});

// ── POST /time-entries/mark-invoiced ────────────────────────────────────────

const MarkInvoicedSchema = z.object({
  projectId:        z.number().int().positive(),
  startDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoiceReference: z.string().max(100).optional(),
});

router.post("/time-entries/mark-invoiced", async (req, res): Promise<void> => {
  const parsed = MarkInvoicedSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { projectId, startDate, endDate, invoiceReference } = parsed.data;

  const conditions = [
    eq(timeEntriesTable.projectId, projectId),
    isNull(timeEntriesTable.invoicedAt),
  ];
  if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

  const updated = await db
    .update(timeEntriesTable)
    .set({
      invoicedAt:        new Date(),
      invoiceReference:  invoiceReference ?? null,
    })
    .where(and(...conditions))
    .returning({ id: timeEntriesTable.id });

  res.json({ updatedCount: updated.length });
});

export default router;
