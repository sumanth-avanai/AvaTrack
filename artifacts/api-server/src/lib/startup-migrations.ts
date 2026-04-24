/**
 * Startup migrations — idempotent DB fixes that run once on server boot.
 * Safe to run repeatedly.
 */
import { db, employeesTable, timeEntriesTable, projectsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PROJECT_COLORS } from "@workspace/api-zod";
import { logger } from "./logger";

export async function runStartupMigrations(): Promise<void> {
  await migrateHoursPerWeekToHoursPerDay();
  await fixWorkingDaysMasks();
  await deleteZeroHourEntries();
  await backfillProjectColors();
}

/**
 * Task #74: hoursPerWeek → hoursPerDay column migration.
 *
 * If `hours_per_week` still exists (environment not yet schema-pushed),
 * add `hours_per_day`, backfill from `hours_per_week` using ÷5 rounding,
 * then drop the old column.  If `hours_per_week` is already gone this is a
 * complete no-op — safe to run on every boot.
 */
async function migrateHoursPerWeekToHoursPerDay(): Promise<void> {
  try {
    const result = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'resource_bookings'
          AND column_name  = 'hours_per_week'
      ) AS exists
    `);

    const rows = Array.isArray(result) ? result : (result as { rows: { exists: boolean }[] }).rows;
    if (!rows[0]?.exists) return;

    logger.info("startup-migration: backfilling hours_per_day from hours_per_week");

    await db.execute(sql`
      ALTER TABLE resource_bookings
        ADD COLUMN IF NOT EXISTS hours_per_day REAL;

      UPDATE resource_bookings
        SET hours_per_day = ROUND(CAST(hours_per_week / 5.0 AS NUMERIC), 2)
        WHERE hours_per_day IS NULL;

      ALTER TABLE resource_bookings
        ALTER COLUMN hours_per_day SET NOT NULL;

      ALTER TABLE resource_bookings
        DROP COLUMN IF EXISTS hours_per_week;
    `);

    logger.info("startup-migration: hours_per_day backfill complete");
  } catch (err) {
    logger.error({ err }, "startup-migration: migrateHoursPerWeekToHoursPerDay failed");
  }
}

/**
 * Fix employees whose working_days_mask is "0,1,1,1,1,1,0" (old Tue–Sat default)
 * and update them to "1,1,1,1,1,0,0" (correct Mon–Fri).
 */
async function fixWorkingDaysMasks(): Promise<void> {
  try {
    const result = await db
      .update(employeesTable)
      .set({ workingDaysMask: "1,1,1,1,1,0,0" })
      .where(eq(employeesTable.workingDaysMask, "0,1,1,1,1,1,0"))
      .returning({ id: employeesTable.id, name: employeesTable.name });

    if (result.length > 0) {
      logger.info(
        { fixed: result.map((r) => `${r.id}:${r.name}`) },
        `startup-migration: fixed ${result.length} employee working-day mask(s)`
      );
    }
  } catch (err) {
    logger.error({ err }, "startup-migration: fixWorkingDaysMasks failed");
  }
}

/**
 * Delete any time_entries rows where hours = 0. These should never exist
 * (the bulkUpsert endpoint deletes them), but a cleanup pass is harmless.
 */
async function deleteZeroHourEntries(): Promise<void> {
  try {
    const result = await db
      .delete(timeEntriesTable)
      .where(sql`${timeEntriesTable.hours} = 0`)
      .returning({ id: timeEntriesTable.id });

    if (result.length > 0) {
      logger.info(
        { count: result.length },
        `startup-migration: deleted ${result.length} zero-hour time entr(ies)`
      );
    }
  } catch (err) {
    logger.error({ err }, "startup-migration: deleteZeroHourEntries failed");
  }
}

/**
 * Assign a palette color (derived from project ID) to every project whose
 * color column is NULL. Uses the same 20-color palette and modulo formula
 * as the Resource Planner's `resolveColor` helper so Gantt bars match.
 */
async function backfillProjectColors(): Promise<void> {
  try {
    const nullColorProjects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(isNull(projectsTable.color));

    if (nullColorProjects.length === 0) return;

    for (const { id } of nullColorProjects) {
      const color = PROJECT_COLORS[id % PROJECT_COLORS.length];
      await db
        .update(projectsTable)
        .set({ color })
        .where(and(eq(projectsTable.id, id), isNull(projectsTable.color)));
    }

    logger.info(
      { count: nullColorProjects.length },
      `startup-migration: backfilled colors for ${nullColorProjects.length} project(s)`
    );
  } catch (err) {
    logger.error({ err }, "startup-migration: backfillProjectColors failed");
  }
}
