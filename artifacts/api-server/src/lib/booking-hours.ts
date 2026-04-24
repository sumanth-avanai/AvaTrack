/**
 * Calculate total hours and budget-day equivalents for a resource booking,
 * supporting both flat hoursPerDay mode and per-weekday hour overrides.
 *
 * weekdayHours maps ISO weekday string ("1"=Mon … "5"=Fri) to hours.
 * Pass null to use flat mode (bookableDays × hoursPerDay).
 *
 * Budget days are always in 8h equivalents: totalHours / 8.
 */

export type WeekdayHoursMap = Record<string, number>;

export function calcBookingHours(
  startStr: string,
  endStr: string,
  hoursPerDay: number,
  weekdayHours: WeekdayHoursMap | null,
  holidayDates: string[] = [],
  vacationDateSet: Set<string> = new Set(),
): { totalHours: number; budgetDays: number } {
  const holidaySet = new Set(holidayDates);
  let totalHours = 0;

  const d = new Date(startStr + "T00:00:00Z");
  const e = new Date(endStr   + "T00:00:00Z");

  while (d <= e) {
    const dow     = d.getUTCDay(); // 0=Sun … 6=Sat
    const dateStr = d.toISOString().slice(0, 10);

    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr) && !vacationDateSet.has(dateStr)) {
      if (weekdayHours != null) {
        totalHours += weekdayHours[String(dow)] ?? 0;
      } else {
        totalHours += hoursPerDay;
      }
    }

    d.setUTCDate(d.getUTCDate() + 1);
  }

  return { totalHours, budgetDays: totalHours / 8 };
}
