/**
 * Utilization calculation logic.
 *
 * Available hours = theoretical working hours in a period based on:
 *   - employee weekly_capacity_hours and working days mask
 *   - minus holidays from the assigned calendar that fall on employee working days
 *
 * Daily capacity = weekly_capacity_hours / number_of_active_working_days
 * Example: 40h, Mon-Fri → 8h/day. 20h, Mon-Fri → 4h/day. 32h, Mon-Thu → 8h/day.
 *
 * If a holiday falls on a day the employee doesn't work → no deduction.
 */

/**
 * Parse the working_days_mask stored as "1,1,1,1,1,0,0" (Mon=index 0, Sun=index 6).
 * Returns an array of 7 booleans.
 */
export function parseWorkingDaysMask(mask: string): boolean[] {
  return mask.split(",").map((v) => v.trim() === "1");
}

/**
 * Get the ISO day index (0=Mon, 6=Sun) for a given Date.
 * MUST use getUTCDay() — dates are always created as UTC midnight,
 * so getDay() (local time) would return the wrong weekday in non-UTC servers.
 */
function getIsoDayIndex(date: Date): number {
  const d = date.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat  (UTC, not local time)
  return d === 0 ? 6 : d - 1; // convert to 0=Mon ... 6=Sun
}

/**
 * Calculate available working hours for an employee between startDate and endDate (inclusive).
 *
 * @param startDate - ISO date string "YYYY-MM-DD"
 * @param endDate   - ISO date string "YYYY-MM-DD"
 * @param workingDaysMask - stored mask string e.g. "1,1,1,1,1,0,0"
 * @param weeklyCapacityHours - e.g. 40, 20, 32
 * @param holidayDates - array of holiday ISO date strings "YYYY-MM-DD" from the employee's calendar
 */
export function calculateAvailableHours(
  startDate: string,
  endDate: string,
  workingDaysMask: string,
  weeklyCapacityHours: number,
  holidayDates: string[]
): number {
  const mask = parseWorkingDaysMask(workingDaysMask);

  // Number of active working days per week
  const activeDaysPerWeek = mask.filter(Boolean).length;
  if (activeDaysPerWeek === 0) return 0;

  // Daily capacity in hours
  const dailyCapacity = weeklyCapacityHours / activeDaysPerWeek;

  // Build a Set for fast holiday lookup
  const holidaySet = new Set(holidayDates);

  let availableHours = 0;
  const current = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const dayIndex = getIsoDayIndex(current);
    const isWorkingDay = mask[dayIndex];

    if (isWorkingDay) {
      const isoDate = current.toISOString().slice(0, 10);
      if (!holidaySet.has(isoDate)) {
        // Not a holiday → count the full daily capacity
        availableHours += dailyCapacity;
      }
      // If it IS a holiday that falls on a working day → deduct (skip adding)
    }
    // If holiday falls on non-working day → no deduction (not counting it either way)

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return Math.round(availableHours * 100) / 100;
}

/**
 * Returns the Monday of the week containing the given date.
 */
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // adjust for Monday start
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/**
 * Returns ISO date string "YYYY-MM-DD" for a Date object.
 */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
