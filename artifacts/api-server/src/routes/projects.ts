import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";

import { db, projectsTable, clientsTable } from "@workspace/db";
import { PROJECT_COLORS } from "@workspace/api-zod";
import {
  ListProjectsQueryParams,
  CreateProjectBody,
  GetProjectParams,
  UpdateProjectParams,
  UpdateProjectBody,
  DeleteProjectParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function enrichProject(project: typeof projectsTable.$inferSelect) {
  const [client] = await db
    .select({ name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, project.clientId));
  return { ...project, clientName: client?.name ?? null };
}

router.get("/projects", async (req, res): Promise<void> => {
  const query = ListProjectsQueryParams.safeParse(req.query);
  const includeInactive = query.success ? query.data.includeInactive : false;
  const clientId = query.success ? query.data.clientId : undefined;

  const conditions = [];
  if (!includeInactive) conditions.push(eq(projectsTable.active, true));
  if (clientId) conditions.push(eq(projectsTable.clientId, clientId));

  const rows = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      code: projectsTable.code,
      active: projectsTable.active,
      isBillable: projectsTable.isBillable,
      budgetHours: projectsTable.budgetHours,
      startDate: projectsTable.startDate,
      endDate: projectsTable.endDate,
      color: projectsTable.color,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(projectsTable.name);

  res.json(rows);
});

router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const project = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(projectsTable)
      .values({
        clientId: parsed.data.clientId,
        name: parsed.data.name,
        code: parsed.data.code ?? null,
        active: parsed.data.active ?? true,
        isBillable: parsed.data.isBillable ?? true,
        budgetHours: parsed.data.budgetHours ?? null,
        startDate: parsed.data.startDate ?? null,
        endDate: parsed.data.endDate ?? null,
        color: parsed.data.color ?? null,
      })
      .returning();

    if (parsed.data.color == null) {
      const paletteColor = PROJECT_COLORS[inserted.id % PROJECT_COLORS.length];
      const [updated] = await tx
        .update(projectsTable)
        .set({ color: paletteColor })
        .where(eq(projectsTable.id, inserted.id))
        .returning();
      return updated;
    }

    return inserted;
  });

  const enriched = await enrichProject(project);
  res.status(201).json(enriched);
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      code: projectsTable.code,
      active: projectsTable.active,
      isBillable: projectsTable.isBillable,
      budgetHours: projectsTable.budgetHours,
      startDate: projectsTable.startDate,
      endDate: projectsTable.endDate,
      color: projectsTable.color,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(row);
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set(parsed.data)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const enriched = await enrichProject(project);
  res.json(enriched);
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
