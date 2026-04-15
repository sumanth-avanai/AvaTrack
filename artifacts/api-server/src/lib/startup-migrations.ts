/**
 * Startup migrations — idempotent DB fixes that run once on server boot.
 * Safe to run repeatedly.
 */
import { db, employeesTable, timeEntriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export async function runStartupMigrations(): Promise<void> {
  await fixWorkingDaysMasks();
  await deleteZeroHourEntries();
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
