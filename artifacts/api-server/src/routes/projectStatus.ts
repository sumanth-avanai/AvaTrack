/**
 * GET  /api/project-status                          — overview list (all projects + latest health)
 * GET  /api/project-status/:projectId               — detail (project + full health history)
 * POST /api/project-status/:projectId/health-updates — create health update + patch project status fields
 */

import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  projectsTable,
  clientsTable,
  projectHealthUpdatesTable,
} from "@workspace/db";

const router: IRouter = Router();

// ── GET /api/project-status ───────────────────────────────────────────────────

router.get("/project-status", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      clientName: clientsTable.name,
      pmName: projectsTable.pmName,
      generalStatus: projectsTable.generalStatus,
      riskLevel: projectsTable.riskLevel,
      clientSatisfaction: projectsTable.clientSatisfaction,
      latestUpdateAt: sql<string | null>`(
        SELECT to_char(phu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
        ORDER BY phu.created_at DESC
        LIMIT 1
      )`,
      latestComment: sql<string | null>`(
        SELECT phu.comment
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
        ORDER BY phu.created_at DESC
        LIMIT 1
      )`,
      budgetTotal: sql<number | null>`(
        SELECT SUM(pr.budgeted_days * pr.day_rate)
        FROM project_roles pr
        WHERE pr.project_id = ${projectsTable.id}
          AND pr.budgeted_days IS NOT NULL
          AND pr.day_rate IS NOT NULL
      )`,
      budgetConsumed: sql<number | null>`(
        SELECT SUM((te.hours / 8.0) * pr.day_rate)
        FROM time_entries te
        JOIN project_roles pr ON pr.id = te.project_role_id
        WHERE te.project_id = ${projectsTable.id}
          AND pr.day_rate IS NOT NULL
      )`,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .orderBy(projectsTable.name);

  res.json(rows);
});

// ── GET /api/project-status/:projectId ───────────────────────────────────────

router.get("/project-status/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      pmName: projectsTable.pmName,
      generalStatus: projectsTable.generalStatus,
      riskLevel: projectsTable.riskLevel,
      clientSatisfaction: projectsTable.clientSatisfaction,
      budgetTotal: sql<number | null>`(
        SELECT SUM(pr.budgeted_days * pr.day_rate)
        FROM project_roles pr
        WHERE pr.project_id = ${projectsTable.id}
          AND pr.budgeted_days IS NOT NULL
          AND pr.day_rate IS NOT NULL
      )`,
      budgetConsumed: sql<number | null>`(
        SELECT SUM((te.hours / 8.0) * pr.day_rate)
        FROM time_entries te
        JOIN project_roles pr ON pr.id = te.project_role_id
        WHERE te.project_id = ${projectsTable.id}
          AND pr.day_rate IS NOT NULL
      )`,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const history = await db
    .select()
    .from(projectHealthUpdatesTable)
    .where(eq(projectHealthUpdatesTable.projectId, projectId))
    .orderBy(desc(projectHealthUpdatesTable.createdAt));

  res.json({ project, history });
});

// ── POST /api/project-status/:projectId/health-updates ────────────────────────

const HealthUpdateSchema = z.object({
  generalStatus:      z.enum(["planned", "in_progress", "on_hold", "completed", "cancelled"]),
  budgetStatus:       z.string().optional(),
  riskLevel:          z.enum(["low", "medium", "high"]),
  clientSatisfaction: z.enum(["happy", "neutral", "critical"]).optional(),
  comment:            z.string().optional(),
});

router.post("/project-status/:projectId/health-updates", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [exists] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!exists) { res.status(404).json({ error: "Project not found" }); return; }

  const parsed = HealthUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { generalStatus, budgetStatus, riskLevel, clientSatisfaction, comment } = parsed.data;

  const entry = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(projectHealthUpdatesTable)
      .values({
        projectId,
        generalStatus,
        budgetStatus: budgetStatus ?? null,
        riskLevel,
        clientSatisfaction: clientSatisfaction ?? null,
        comment: comment ?? null,
      })
      .returning();

    await tx
      .update(projectsTable)
      .set({ generalStatus, riskLevel, clientSatisfaction: clientSatisfaction ?? null })
      .where(eq(projectsTable.id, projectId));

    return inserted;
  });

  res.status(201).json(entry);
});

export default router;
