import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { db, timeEntriesTable, projectsTable, clientsTable } from "@workspace/db";
import {
  ListTimeEntriesQueryParams,
  CreateTimeEntryBody,
  BulkUpsertTimeEntriesBody,
  GetTimeEntryParams,
  UpdateTimeEntryParams,
  UpdateTimeEntryBody,
  DeleteTimeEntryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function enrichEntries(entries: (typeof timeEntriesTable.$inferSelect)[]) {
  if (entries.length === 0) return [];
  const projectIds = [...new Set(entries.map((e) => e.projectId))];
  const projects = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      isBillable: projectsTable.isBillable,
      clientName: clientsTable.name,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(inArray(projectsTable.id, projectIds));

  const projectMap = new Map(projects.map((p) => [p.id, p]));

  return entries.map((e) => {
    const project = projectMap.get(e.projectId);
    return {
      ...e,
      projectName: project?.name ?? null,
      clientName: project?.clientName ?? null,
      isBillable: project?.isBillable ?? null,
    };
  });
}

router.get("/time-entries", async (req, res): Promise<void> => {
  // Parse date strings directly — zod.date() rejects plain "YYYY-MM-DD" strings from query params.
  const employeeId = req.query.employeeId ? parseInt(String(req.query.employeeId), 10) : undefined;
  const projectId  = req.query.projectId  ? parseInt(String(req.query.projectId),  10) : undefined;

  const startDateRaw = req.query.startDate;
  const endDateRaw   = req.query.endDate;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = typeof startDateRaw === "string" && dateRe.test(startDateRaw) ? startDateRaw : undefined;
  const endDate   = typeof endDateRaw   === "string" && dateRe.test(endDateRaw)   ? endDateRaw   : undefined;

  const conditions = [];
  if (employeeId && !isNaN(employeeId)) conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  if (projectId  && !isNaN(projectId))  conditions.push(eq(timeEntriesTable.projectId,  projectId));
  if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

  const entries = await db
    .select()
    .from(timeEntriesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(timeEntriesTable.entryDate);

  const enriched = await enrichEntries(entries);
  res.json(enriched);
});

router.post("/time-entries", async (req, res): Promise<void> => {
  const parsed = CreateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.hours < 0 || parsed.data.hours > 24) {
    res.status(400).json({ error: "Hours must be between 0 and 24" });
    return;
  }

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: parsed.data.employeeId,
      projectId: parsed.data.projectId,
      entryDate: parsed.data.entryDate,
      hours: parsed.data.hours,
      note: parsed.data.note ?? null,
    })
    .returning();

  const [enriched] = await enrichEntries([entry]);
  res.status(201).json(enriched);
});

router.post("/time-entries/bulk", async (req, res): Promise<void> => {
  const parsed = BulkUpsertTimeEntriesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const results: (typeof timeEntriesTable.$inferSelect)[] = [];

  for (const item of parsed.data.entries) {
    if (item.hours < 0 || item.hours > 24) continue;

    // Find existing entry for same employee/project/date
    const [existing] = await db
      .select()
      .from(timeEntriesTable)
      .where(
        and(
          eq(timeEntriesTable.employeeId, item.employeeId),
          eq(timeEntriesTable.projectId, item.projectId),
          eq(timeEntriesTable.entryDate, item.entryDate)
        )
      );

    if (existing) {
      if (item.hours === 0) {
        // Delete zero-hour entries
        await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, existing.id));
      } else {
        const [updated] = await db
          .update(timeEntriesTable)
          .set({ hours: item.hours, note: item.note ?? existing.note })
          .where(eq(timeEntriesTable.id, existing.id))
          .returning();
        results.push(updated);
      }
    } else if (item.hours > 0) {
      const [created] = await db
        .insert(timeEntriesTable)
        .values({
          employeeId: item.employeeId,
          projectId: item.projectId,
          entryDate: item.entryDate,
          hours: item.hours,
          note: item.note ?? null,
        })
        .returning();
      results.push(created);
    }
  }

  const enriched = await enrichEntries(results);
  res.json(enriched);
});

router.get("/time-entries/:id", async (req, res): Promise<void> => {
  const params = GetTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .select()
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id));

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const [enriched] = await enrichEntries([entry]);
  res.json(enriched);
});

router.patch("/time-entries/:id", async (req, res): Promise<void> => {
  const params = UpdateTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.hours !== undefined && (parsed.data.hours < 0 || parsed.data.hours > 24)) {
    res.status(400).json({ error: "Hours must be between 0 and 24" });
    return;
  }

  const [entry] = await db
    .update(timeEntriesTable)
    .set(parsed.data)
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const [enriched] = await enrichEntries([entry]);
  res.json(enriched);
});

router.delete("/time-entries/:id", async (req, res): Promise<void> => {
  const params = DeleteTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .delete(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
