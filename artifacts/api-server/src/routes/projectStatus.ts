/**
 * GET  /api/project-status                          — overview list (all active projects + latest health)
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
      budgetStatus: projectsTable.budgetStatus,
      riskLevel: projectsTable.riskLevel,
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
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.active, true))
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
      budgetStatus: projectsTable.budgetStatus,
      riskLevel: projectsTable.riskLevel,
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
  generalStatus: z.enum(["planned", "in_progress", "on_hold", "completed", "cancelled"]),
  budgetStatus:  z.enum(["on_track", "at_risk", "over_budget", "completed"]),
  riskLevel:     z.enum(["low", "medium", "high"]),
  comment:       z.string().optional(),
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

  const { generalStatus, budgetStatus, riskLevel, comment } = parsed.data;

  const entry = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(projectHealthUpdatesTable)
      .values({ projectId, generalStatus, budgetStatus, riskLevel, comment: comment ?? null })
      .returning();

    await tx
      .update(projectsTable)
      .set({ generalStatus, budgetStatus, riskLevel })
      .where(eq(projectsTable.id, projectId));

    return inserted;
  });

  res.status(201).json(entry);
});

export default router;
