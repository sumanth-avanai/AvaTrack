/**
 * GET  /api/billing?startDate=&endDate=
 *   Returns logged vs invoiced vs invest revenue for ALL projects, grouped by
 *   client → project → role → employee.
 *
 * GET  /api/projects/:id/billing?startDate=&endDate=
 *   Returns logged vs invoiced vs invest revenue per role and employee.
 *
 * POST /api/time-entries/mark-invoiced  (legacy — marks all unbilled for project)
 * POST /api/time-entries/update-billing-status  (new — per-item selection)
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  clientsTable,
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

// ── GET /billing  (all projects) ────────────────────────────────────────────

router.get("/billing", async (req, res): Promise<void> => {
  const startDate = parseDate(req.query.startDate);
  const endDate   = parseDate(req.query.endDate);

  // Fetch all clients
  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .orderBy(clientsTable.name);

  // Fetch all projects with their clientId
  const projects = await db
    .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
    .from(projectsTable)
    .orderBy(projectsTable.name);

  // Fetch all roles across all projects
  const roles = await db
    .select({
      id: projectRolesTable.id,
      name: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
      budgetedDays: projectRolesTable.budgetedDays,
      projectId: projectRolesTable.projectId,
    })
    .from(projectRolesTable)
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) {
    const clientsOut = clients.map((c) => ({
      id: c.id, name: c.name,
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      projects: [],
    }));
    res.json({
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      clients: clientsOut.filter((c) => {
        const cProjects = projects.filter((p) => p.clientId === c.id);
        return cProjects.length > 0;
      }),
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Build date conditions
  const entryConditions: ReturnType<typeof eq>[] = [
    sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
  ];
  if (startDate) entryConditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   entryConditions.push(lte(timeEntriesTable.entryDate, endDate));

  // Aggregate hours per (projectId, roleId, employeeId)
  const entryRows = await db
    .select({
      projectId:    timeEntriesTable.projectId,
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId:    timeEntriesTable.employeeId,
      employeeName:  employeesTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invoiced' THEN ${timeEntriesTable.hours}
        WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
      investHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invest' THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(and(...entryConditions))
    .groupBy(
      timeEntriesTable.projectId,
      timeEntriesTable.projectRoleId,
      timeEntriesTable.employeeId,
      employeesTable.name,
    );

  type EmpAgg = {
    employeeId: number;
    employeeName: string;
    totalHours: number;
    invoicedHours: number;
    investHours: number;
  };
  // Map: roleId → EmpAgg[]
  const byRole = new Map<number, EmpAgg[]>();
  for (const row of entryRows) {
    if (row.projectRoleId == null) continue;
    if (!byRole.has(row.projectRoleId)) byRole.set(row.projectRoleId, []);
    byRole.get(row.projectRoleId)!.push({
      employeeId:    row.employeeId,
      employeeName:  row.employeeName ?? `#${row.employeeId}`,
      totalHours:    Number(row.totalHours),
      invoicedHours: Number(row.invoicedHours),
      investHours:   Number(row.investHours),
    });
  }

  // Build project lookup by id
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Build roles per project
  const rolesByProject = new Map<number, typeof roles>();
  for (const role of roles) {
    if (!rolesByProject.has(role.projectId)) rolesByProject.set(role.projectId, []);
    rolesByProject.get(role.projectId)!.push(role);
  }

  let grandBudget   = 0;
  let grandLogged   = 0;
  let grandInvoiced = 0;
  let grandInvest   = 0;

  // Build client → project → role → employee tree
  const clientsOut = clients
    .map((client) => {
      const clientProjects = projects.filter((p) => p.clientId === client.id);
      if (clientProjects.length === 0) return null;

      let clientBudget   = 0;
      let clientLogged   = 0;
      let clientInvoiced = 0;
      let clientInvest   = 0;

      const projectsOut = clientProjects.map((project) => {
        const projectRoles = rolesByProject.get(project.id) ?? [];

        let projBudget   = 0;
        let projLogged   = 0;
        let projInvoiced = 0;
        let projInvest   = 0;

        const rolesOut = projectRoles.map((role) => {
          const empRows = byRole.get(role.id) ?? [];
          const dayRate = role.dayRate;

          const employees = empRows
            .map((e) => {
              const loggedHours   = e.totalHours;
              const invoicedHours = e.invoicedHours;
              const investHours   = e.investHours;
              const loggedDays    = round2(loggedHours / 8);
              const revenue       = round2(loggedDays * dayRate);
              const invoiced      = round2((invoicedHours / 8) * dayRate);
              const invest        = round2((investHours / 8) * dayRate);
              const unbilled      = round2(revenue - invoiced - invest);
              const billingStatus =
                invoicedHours > 0 && investHours === 0 ? "invoiced" as const :
                investHours > 0 && invoicedHours === 0 ? "invest" as const :
                null;
              return { id: e.employeeId, name: e.employeeName, hours: loggedHours, days: loggedDays, revenue, invoiced, invest, unbilled, billingStatus };
            })
            .sort((a, b) => b.revenue - a.revenue);

          const roleLoggedHours   = employees.reduce((s, e) => s + e.hours,    0);
          const roleLoggedDays    = round2(roleLoggedHours / 8);
          const logged            = round2(roleLoggedDays * dayRate);
          const invoiced          = round2(employees.reduce((s, e) => s + e.invoiced, 0));
          const invest            = round2(employees.reduce((s, e) => s + e.invest,   0));
          const unbilled          = round2(logged - invoiced - invest);
          const budget            = role.budgetedDays != null ? round2(role.budgetedDays * dayRate) : null;
          const remaining         = budget != null ? round2(budget - logged) : null;

          if (budget != null) projBudget += budget;
          projLogged   += logged;
          projInvoiced += invoiced;
          projInvest   += invest;

          return {
            id: role.id, name: role.name,
            dayrate: dayRate,
            budgetedDays: role.budgetedDays,
            budget, loggedDays: roleLoggedDays, loggedHours: round2(roleLoggedHours),
            logged, invoiced, invest, unbilled, remaining,
            employees,
          };
        });

        const projUnbilled  = round2(projLogged - projInvoiced - projInvest);
        const projRemaining = round2(projBudget - projLogged);

        clientBudget   += projBudget;
        clientLogged   += projLogged;
        clientInvoiced += projInvoiced;
        clientInvest   += projInvest;

        return {
          id: project.id, name: project.name,
          totals: {
            budget:   round2(projBudget),
            logged:   round2(projLogged),
            invoiced: round2(projInvoiced),
            invest:   round2(projInvest),
            unbilled: projUnbilled,
            remaining: projRemaining,
          },
          roles: rolesOut,
        };
      });

      const clientUnbilled  = round2(clientLogged - clientInvoiced - clientInvest);
      const clientRemaining = round2(clientBudget - clientLogged);

      grandBudget   += clientBudget;
      grandLogged   += clientLogged;
      grandInvoiced += clientInvoiced;
      grandInvest   += clientInvest;

      return {
        id: client.id, name: client.name,
        totals: {
          budget:    round2(clientBudget),
          logged:    round2(clientLogged),
          invoiced:  round2(clientInvoiced),
          invest:    round2(clientInvest),
          unbilled:  clientUnbilled,
          remaining: clientRemaining,
        },
        projects: projectsOut,
      };
    })
    .filter(Boolean);

  const grandUnbilled  = round2(grandLogged - grandInvoiced - grandInvest);
  const grandRemaining = round2(grandBudget - grandLogged);

  res.json({
    totals: {
      budget:    round2(grandBudget),
      logged:    round2(grandLogged),
      invoiced:  round2(grandInvoiced),
      invest:    round2(grandInvest),
      unbilled:  grandUnbilled,
      remaining: grandRemaining,
    },
    clients: clientsOut,
  });
});

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
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      roles: [],
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Build date conditions
  const entryConditions = [
    eq(timeEntriesTable.projectId, projectId),
    sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
  ];
  if (startDate) entryConditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   entryConditions.push(lte(timeEntriesTable.entryDate, endDate));

  // Aggregate hours per (roleId, employeeId)
  // invoicedHours: billing_status='invoiced' OR (billing_status IS NULL AND invoiced_at IS NOT NULL) for legacy entries
  // investHours:   billing_status='invest'
  const entryRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId:    timeEntriesTable.employeeId,
      employeeName:  employeesTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invoiced' THEN ${timeEntriesTable.hours}
        WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
      investHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invest' THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(and(...entryConditions))
    .groupBy(
      timeEntriesTable.projectRoleId,
      timeEntriesTable.employeeId,
      employeesTable.name,
    );

  type EmpRow = {
    employeeId: number;
    employeeName: string;
    totalHours: number;
    invoicedHours: number;
    investHours: number;
  };
  const byRole = new Map<number, EmpRow[]>();
  for (const row of entryRows) {
    if (row.projectRoleId == null) continue;
    if (!byRole.has(row.projectRoleId)) byRole.set(row.projectRoleId, []);
    byRole.get(row.projectRoleId)!.push({
      employeeId:    row.employeeId,
      employeeName:  row.employeeName ?? `#${row.employeeId}`,
      totalHours:    Number(row.totalHours),
      invoicedHours: Number(row.invoicedHours),
      investHours:   Number(row.investHours),
    });
  }

  let totalBudget   = 0;
  let totalLogged   = 0;
  let totalInvoiced = 0;
  let totalInvest   = 0;

  const rolesOut = roles.map((role) => {
    const empRows = byRole.get(role.id) ?? [];
    const dayRate = role.dayRate;

    const employees = empRows
      .map((e) => {
        const loggedHours    = e.totalHours;
        const invoicedHours  = e.invoicedHours;
        const investHours    = e.investHours;
        const logged         = round2((loggedHours / 8) * dayRate);
        const invoiced       = round2((invoicedHours / 8) * dayRate);
        const invest         = round2((investHours / 8) * dayRate);
        const unbilled       = round2(logged - invoiced - invest);
        // Dominant billing status for badge
        const billingStatus =
          invoicedHours > 0 && investHours === 0 ? "invoiced" as const :
          investHours > 0 && invoicedHours === 0 ? "invest" as const :
          null;
        return { id: e.employeeId, name: e.employeeName, loggedHours, logged, invoicedHours, invoiced, investHours, invest, unbilled, billingStatus };
      })
      .sort((a, b) => b.logged - a.logged);

    const roleLoggedHours   = employees.reduce((s, e) => s + e.loggedHours,   0);
    const roleInvoicedHours = employees.reduce((s, e) => s + e.invoicedHours, 0);
    const roleInvestHours   = employees.reduce((s, e) => s + e.investHours,   0);
    const logged            = round2((roleLoggedHours / 8) * dayRate);
    const invoiced          = round2((roleInvoicedHours / 8) * dayRate);
    const invest            = round2((roleInvestHours / 8) * dayRate);
    const unbilled          = round2(logged - invoiced - invest);
    const budget            = role.budgetedDays != null ? round2(role.budgetedDays * dayRate) : null;
    const remaining         = budget != null ? round2(budget - logged) : null;

    if (budget != null) totalBudget += budget;
    totalLogged   += logged;
    totalInvoiced += invoiced;
    totalInvest   += invest;

    return {
      id:            role.id,
      name:          role.name,
      dayrate:       dayRate,
      budgetedDays:  role.budgetedDays,
      budget,
      loggedHours:   round2(roleLoggedHours),
      logged,
      invoicedHours: round2(roleInvoicedHours),
      invoiced,
      investHours:   round2(roleInvestHours),
      invest,
      unbilled,
      remaining,
      employees,
    };
  });

  const totalUnbilled  = round2(totalLogged - totalInvoiced - totalInvest);
  const totalRemaining = round2(totalBudget - totalLogged);

  res.json({
    project,
    totals: {
      budget:    round2(totalBudget),
      logged:    round2(totalLogged),
      invoiced:  round2(totalInvoiced),
      invest:    round2(totalInvest),
      unbilled:  totalUnbilled,
      remaining: totalRemaining,
    },
    roles: rolesOut,
  });
});

// ── GET /projects/:projectId/billing/history ─────────────────────────────────

router.get("/projects/:projectId/billing/history", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Fetch all invoiced entries for this project that have a role
  const rows = await db
    .select({
      invoiceReference:  timeEntriesTable.invoiceReference,
      invoicedAt:        timeEntriesTable.invoicedAt,
      hours:             timeEntriesTable.hours,
      projectRoleId:     timeEntriesTable.projectRoleId,
      projectRoleName:   projectRolesTable.name,
      dayRate:           projectRolesTable.dayRate,
      employeeId:        timeEntriesTable.employeeId,
      employeeName:      employeesTable.name,
    })
    .from(timeEntriesTable)
    .leftJoin(projectRolesTable, eq(timeEntriesTable.projectRoleId, projectRolesTable.id))
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`(
          ${timeEntriesTable.billingStatus} = 'invoiced'
          OR (${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL)
        )`,
      ),
    )
    .orderBy(timeEntriesTable.invoicedAt);

  // Group by invoice reference. For entries without a reference each distinct
  // invoicedAt timestamp is its own audit event (preserves granularity).
  type HistoryGroup = {
    reference: string | null;
    invoicedAt: Date;
    totalAmount: number;
    roles: { id: number; name: string }[];
    employees: { id: number; name: string }[];
  };

  const groups = new Map<string, HistoryGroup>();

  for (const row of rows) {
    const invoicedAt = row.invoicedAt ?? new Date(0);
    const key = row.invoiceReference
      ? `ref:${row.invoiceReference}`
      : `ts:${invoicedAt.toISOString()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        reference:   row.invoiceReference ?? null,
        invoicedAt,
        totalAmount: 0,
        roles:       [],
        employees:   [],
      });
    }

    const g = groups.get(key)!;

    // Update invoicedAt to the latest timestamp within the group
    if (row.invoicedAt && row.invoicedAt > g.invoicedAt) g.invoicedAt = row.invoicedAt;

    // Accumulate amount
    if (row.dayRate != null) {
      g.totalAmount += round2((Number(row.hours) / 8) * row.dayRate);
    }

    // Track unique roles
    if (row.projectRoleId != null && !g.roles.find((r) => r.id === row.projectRoleId)) {
      g.roles.push({ id: row.projectRoleId, name: row.projectRoleName ?? `Role #${row.projectRoleId}` });
    }

    // Track unique employees
    if (row.employeeId != null && !g.employees.find((e) => e.id === row.employeeId)) {
      g.employees.push({ id: row.employeeId, name: row.employeeName ?? `#${row.employeeId}` });
    }
  }

  // Sort by invoicedAt descending (most recent first)
  const history = Array.from(groups.values())
    .sort((a, b) => b.invoicedAt.getTime() - a.invoicedAt.getTime())
    .map((g) => ({
      reference:     g.reference,
      invoicedAt:    g.invoicedAt.toISOString(),
      totalAmount:   round2(g.totalAmount),
      roleCount:     g.roles.length,
      employeeCount: g.employees.length,
      roles:         g.roles,
      employees:     g.employees,
    }));

  res.json({ project, history });
});

// ── POST /time-entries/mark-invoiced (legacy) ────────────────────────────────

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
    // Exclude invest entries — legacy endpoint must not overwrite explicit invest status
    sql`(${timeEntriesTable.billingStatus} IS NULL OR ${timeEntriesTable.billingStatus} != 'invest')`,
  ];
  if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

  const updated = await db
    .update(timeEntriesTable)
    .set({
      billingStatus:    "invoiced",
      invoicedAt:       new Date(),
      invoiceReference: invoiceReference ?? null,
    })
    .where(and(...conditions))
    .returning({ id: timeEntriesTable.id });

  res.json({ updatedCount: updated.length });
});

// ── POST /time-entries/update-billing-status ─────────────────────────────────

const UpdateBillingStatusSchema = z.object({
  projectId:        z.number().int().positive(),
  items:            z.array(z.object({
    roleId:     z.number().int().positive(),
    employeeId: z.number().int().positive().optional(),
  })).min(1),
  startDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status:           z.enum(["invoiced", "invest"]).nullable(),
  invoiceReference: z.string().max(100).optional(),
});

router.post("/time-entries/update-billing-status", async (req, res): Promise<void> => {
  const parsed = UpdateBillingStatusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { projectId, items, startDate, endDate, status, invoiceReference } = parsed.data;

  let updatedCount = 0;

  for (const item of items) {
    const conditions = [
      eq(timeEntriesTable.projectId, projectId),
      eq(timeEntriesTable.projectRoleId, item.roleId),
    ];
    if (item.employeeId != null) conditions.push(eq(timeEntriesTable.employeeId, item.employeeId));
    if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
    if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

    let updated: { id: number }[];
    if (status === "invoiced") {
      updated = await db
        .update(timeEntriesTable)
        .set({
          billingStatus:    "invoiced",
          invoicedAt:       new Date(),
          invoiceReference: invoiceReference ?? null,
        })
        .where(and(...conditions))
        .returning({ id: timeEntriesTable.id });
    } else {
      updated = await db
        .update(timeEntriesTable)
        .set({ billingStatus: status })
        .where(and(...conditions))
        .returning({ id: timeEntriesTable.id });
    }
    updatedCount += updated.length;
  }

  res.json({ updatedCount });
});

export default router;
