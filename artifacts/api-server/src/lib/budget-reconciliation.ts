/**
 * Budget reconciliation: Invoiced | Re-plannable | Unplanned bucket model.
 *
 * Core identity: B = Invoiced + Reserved + Unplanned
 *
 * Reserved ("Re-plannable") = days that are planned but not yet delivered.
 * These are movable — only invoiced work is locked.
 *
 * Per-day reconciliation avoids double-counting overlapping bookings.
 */

import { calcDayHours, calcBookingHours, type WeekdayHoursMap } from "./booking-hours";

export interface ReconciliationBooking {
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  weekdayHours: WeekdayHoursMap | null;
  employeeId: number;
  /** When set, past undelivered planned hours are excluded (released). */
  pastReleasedAt?: Date | null;
  avail: {
    holidayDates: string[];
    vacationDateSet: Set<string>;
    compDayDateSet: Set<string>;
  };
}

export interface ReconciliationTimeEntry {
  entryDate: string;
  hours: number;
  isInvoiced: boolean;
}

export interface ReconciliationResult {
  loggedDays: number;
  invoicedDays: number;
  reservedDays: number;
  unplannedDays: number | null;
  freeDays: number | null;
  remainingBudgetDays: number | null;
  loggedNotInvoicedDays: number;
  plannedDays: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Return the effective budget-days for a single booking, honoring release state.
 *
 * When a booking's past plan has been released (`pastReleasedAt` is set),
 * only future days (>= today) are counted. This keeps the per-employee
 * planned-days figures in budget-status and allocations consistent with
 * the reconciliation output.
 */
export function calcEffectiveBookingBudgetDays(
  booking: {
    startDate: string;
    endDate: string;
    hoursPerDay: number;
    weekdayHours: WeekdayHoursMap | null;
    pastReleasedAt?: Date | null;
  },
  avail: {
    holidayDates?: string[];
    vacationDateSet?: Set<string>;
    compDayDateSet?: Set<string>;
  } | undefined,
  today?: string,
): number {
  if (!booking.pastReleasedAt) {
    return calcBookingHours(
      booking.startDate, booking.endDate,
      booking.hoursPerDay, booking.weekdayHours,
      avail?.holidayDates, avail?.vacationDateSet, avail?.compDayDateSet,
    ).budgetDays;
  }

  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  if (booking.endDate < todayStr) return 0; // entirely in the past
  const futureStart = booking.startDate >= todayStr ? booking.startDate : todayStr;
  return calcBookingHours(
    futureStart, booking.endDate,
    booking.hoursPerDay, booking.weekdayHours,
    avail?.holidayDates, avail?.vacationDateSet, avail?.compDayDateSet,
  ).budgetDays;
}

/**
 * Calculate the four canonical budget buckets for a single role.
 *
 * @param budgetedDays  Role's budgeted days (null = no budget set).
 * @param bookings      All resource bookings for this role, each with avail data.
 * @param timeEntries   All time entries for this role with invoiced status.
 * @param today         Override for "today" — used in tests and bulk-release. Defaults to server date.
 */
export function calcRoleBudgetReconciliation(
  budgetedDays: number | null,
  bookings: ReconciliationBooking[],
  timeEntries: ReconciliationTimeEntry[],
  today?: Date,
): ReconciliationResult {
  const todayStr = (today ?? new Date()).toISOString().slice(0, 10);

  // ── Step 1: build per-day planned-hours map ─────────────────────────────────
  // key: YYYY-MM-DD, value: total planned hours on that day (across all bookings)
  const plannedByDay = new Map<string, number>();

  for (const booking of bookings) {
    const holidaySet = new Set(booking.avail.holidayDates);
    const d = new Date(booking.startDate + "T00:00:00Z");
    const end = new Date(booking.endDate + "T00:00:00Z");
    while (d <= end) {
      const dateStr = d.toISOString().slice(0, 10);

      // If booking was released and this day is strictly before today, skip it
      if (booking.pastReleasedAt && dateStr < todayStr) {
        d.setUTCDate(d.getUTCDate() + 1);
        continue;
      }

      const dow = d.getUTCDay();
      const h = calcDayHours(
        dow,
        dateStr,
        booking.hoursPerDay,
        booking.weekdayHours,
        holidaySet,
        booking.avail.vacationDateSet,
        booking.avail.compDayDateSet,
      );
      if (h > 0) {
        plannedByDay.set(dateStr, (plannedByDay.get(dateStr) ?? 0) + h);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  // ── Step 2: build per-day logged-hours map ──────────────────────────────────
  const loggedByDay = new Map<string, { total: number; invoiced: number }>();
  for (const entry of timeEntries) {
    const existing = loggedByDay.get(entry.entryDate);
    if (existing) {
      existing.total += entry.hours;
      if (entry.isInvoiced) existing.invoiced += entry.hours;
    } else {
      loggedByDay.set(entry.entryDate, {
        total: entry.hours,
        invoiced: entry.isInvoiced ? entry.hours : 0,
      });
    }
  }

  // ── Step 3: aggregate totals ────────────────────────────────────────────────
  let totalLoggedHours = 0;
  let totalInvoicedHours = 0;
  for (const { total, invoiced } of loggedByDay.values()) {
    totalLoggedHours += total;
    totalInvoicedHours += invoiced;
  }

  // ── Step 4: calculate reserved (undelivered planned) ───────────────────────
  // For each day with any planned hours, compute how much was not yet delivered.
  let totalUndeliveredHours = 0;
  for (const [dateStr, plannedHours] of plannedByDay.entries()) {
    const loggedHours = loggedByDay.get(dateStr)?.total ?? 0;
    const undelivered = Math.max(plannedHours - loggedHours, 0);
    totalUndeliveredHours += undelivered;
  }

  // ── Step 5: derive canonical bucket values ──────────────────────────────────
  const loggedDays = round2(totalLoggedHours / 8);
  const invoicedDays = round2(totalInvoicedHours / 8);
  const reservedDays = round2(totalUndeliveredHours / 8);
  const loggedNotInvoicedDays = round2(loggedDays - invoicedDays);

  // plannedDays = total booking days (sum over all bookings; kept for reference)
  let totalPlannedHours = 0;
  for (const h of plannedByDay.values()) totalPlannedHours += h;
  const plannedDays = round2(totalPlannedHours / 8);

  const unplannedDays = budgetedDays != null
    ? round2(budgetedDays - invoicedDays - reservedDays)
    : null;
  const freeDays = budgetedDays != null
    ? round2(budgetedDays - loggedDays)
    : null;
  const remainingBudgetDays = budgetedDays != null
    ? round2(budgetedDays - invoicedDays)
    : null;

  return {
    loggedDays,
    invoicedDays,
    reservedDays,
    unplannedDays,
    freeDays,
    remainingBudgetDays,
    loggedNotInvoicedDays,
    plannedDays,
  };
}
