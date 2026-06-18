import { describe, it, expect } from "vitest";
import {
  calcRoleBudgetReconciliation,
  type ReconciliationBooking,
  type ReconciliationTimeEntry,
} from "./budget-reconciliation";

// All scenarios use Mon-Fri 8h/day flat bookings with no holidays or vacations,
// so every weekday in the range contributes 8h.

const emptyAvail = {
  holidayDates: [] as string[],
  vacationDateSet: new Set<string>(),
  compDayDateSet: new Set<string>(),
};

// Helper: build a flat-rate booking covering exactly `days` working days
// (no weekends; we pick date ranges that are all Mon-Fri for clean arithmetic)
function flatBooking(
  startDate: string,
  endDate: string,
  hoursPerDay = 8,
): ReconciliationBooking {
  return {
    startDate,
    endDate,
    hoursPerDay,
    weekdayHours: null,
    employeeId: 1,
    avail: emptyAvail,
  };
}

// Helper: build invoiced / non-invoiced time entries for a date range
// (all weekdays in the range at 8h/day)
function buildEntries(
  startDate: string,
  days: number,
  isInvoiced: boolean,
): ReconciliationTimeEntry[] {
  const entries: ReconciliationTimeEntry[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  let count = 0;
  while (count < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      entries.push({
        entryDate: d.toISOString().slice(0, 10),
        hours: 8,
        isInvoiced,
      });
      count++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return entries;
}

// ── Scenario 1 ────────────────────────────────────────────────────────────────
// B=20, Plan 10d May + 10d June, Logged 10d May + 2d June, Invoiced 10d (May).
// → Logged=12, Invoiced=10, Reserved=8, Unplanned=2, RemainingBudget=10, Free=8.
// Identity: 10+8+2=20 ✓
describe("Scenario 1 — fully invoiced May, partial June delivery", () => {
  // May 4 (Mon) – May 15 (Fri) = 10 working days
  // Jun 1 (Mon) – Jun 12 (Fri) = 10 working days
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];

  // Logged 10d in May (all invoiced), 2d in June (not invoiced)
  const timeEntries: ReconciliationTimeEntry[] = [
    ...buildEntries("2026-05-04", 10, true),
    ...buildEntries("2026-06-01", 2, false),
  ];

  it("loggedDays = 12", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.loggedDays).toBe(12);
  });

  it("invoicedDays = 10", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.invoicedDays).toBe(10);
  });

  it("reservedDays = 8 (8 undelivered days in June)", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.reservedDays).toBe(8);
  });

  it("unplannedDays = 2", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.unplannedDays).toBe(2);
  });

  it("remainingBudgetDays = 10", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.remainingBudgetDays).toBe(10);
  });

  it("freeDays = 8", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.freeDays).toBe(8);
  });

  it("identity: Invoiced + Reserved + Unplanned = B", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.invoicedDays! + r.reservedDays + r.unplannedDays!).toBeCloseTo(20);
  });
});

// ── Scenario 2 ────────────────────────────────────────────────────────────────
// B=20, Plan 10d May + 10d June, Logged 8d May + 2d June, Invoiced 8d (May).
// → Logged=10, Invoiced=8, Reserved=10, Unplanned=2, RemainingBudget=12, LoggedNotInvoiced=2.
// Identity: 8+10+2=20 ✓
describe("Scenario 2 — partial May invoiced, undelivered in both months", () => {
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];

  // Logged 8d in May (all invoiced), 2d in June (not invoiced)
  const timeEntries: ReconciliationTimeEntry[] = [
    ...buildEntries("2026-05-04", 8, true),
    ...buildEntries("2026-06-01", 2, false),
  ];

  it("loggedDays = 10", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.loggedDays).toBe(10);
  });

  it("invoicedDays = 8", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.invoicedDays).toBe(8);
  });

  it("reservedDays = 10 (2 undelivered May + 8 undelivered June)", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.reservedDays).toBe(10);
  });

  it("unplannedDays = 2", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.unplannedDays).toBe(2);
  });

  it("remainingBudgetDays = 12", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.remainingBudgetDays).toBe(12);
  });

  it("loggedNotInvoicedDays = 2", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.loggedNotInvoicedDays).toBe(2);
  });

  it("identity: Invoiced + Reserved + Unplanned = B", () => {
    const r = calcRoleBudgetReconciliation(20, bookings, timeEntries);
    expect(r.invoicedDays! + r.reservedDays + r.unplannedDays!).toBeCloseTo(20);
  });
});

// ── Scenario 3 ────────────────────────────────────────────────────────────────
// B=50, Plan 10d May + 10d June (30d never planned),
// Logged 15d May (invoiced) + 2d June (not invoiced).
// → Logged=17, Invoiced=15, Reserved=8, Unplanned=27, Free=33.
// Identity: 15+8+27=50 ✓
describe("Scenario 3 — over-delivered May, large unplanned buffer", () => {
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];

  // 15d logged in May (invoiced) — 5 extra days over the 10-day plan
  // 2d logged in June (not invoiced)
  // We need 15 working days starting May 4. May has: May 4-15 = 10d, May 18-22 = 5d → total 15d
  const mayEntries = [
    ...buildEntries("2026-05-04", 10, true),
    ...buildEntries("2026-05-18", 5, true),
  ];
  const juneEntries = buildEntries("2026-06-01", 2, false);
  const timeEntries = [...mayEntries, ...juneEntries];

  it("loggedDays = 17", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.loggedDays).toBe(17);
  });

  it("invoicedDays = 15", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.invoicedDays).toBe(15);
  });

  it("reservedDays = 8 (June plan 10d − logged 2d; May over-delivered so 0 undelivered)", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.reservedDays).toBe(8);
  });

  it("unplannedDays = 27", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.unplannedDays).toBe(27);
  });

  it("freeDays = 33", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.freeDays).toBe(33);
  });

  it("identity: Invoiced + Reserved + Unplanned = B", () => {
    const r = calcRoleBudgetReconciliation(50, bookings, timeEntries);
    expect(r.invoicedDays! + r.reservedDays + r.unplannedDays!).toBeCloseTo(50);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────
describe("Edge cases", () => {
  it("null budget → all budget-derived fields are null", () => {
    const r = calcRoleBudgetReconciliation(
      null,
      [flatBooking("2026-05-04", "2026-05-08")],
      [{ entryDate: "2026-05-04", hours: 8, isInvoiced: false }],
    );
    expect(r.unplannedDays).toBeNull();
    expect(r.freeDays).toBeNull();
    expect(r.remainingBudgetDays).toBeNull();
    expect(r.loggedDays).toBe(1);
    expect(r.reservedDays).toBe(4); // 5d planned − 1d logged
  });

  it("no bookings, no entries → all zeros (budget fields still computed)", () => {
    const r = calcRoleBudgetReconciliation(10, [], []);
    expect(r.loggedDays).toBe(0);
    expect(r.invoicedDays).toBe(0);
    expect(r.reservedDays).toBe(0);
    expect(r.unplannedDays).toBe(10);
    expect(r.freeDays).toBe(10);
    expect(r.remainingBudgetDays).toBe(10);
    expect(r.plannedDays).toBe(0);
  });

  it("over-delivery on a booked day clamps undelivered to 0", () => {
    // Plan 1d, log 2d → undelivered = 0
    const bookings = [flatBooking("2026-05-04", "2026-05-04")];
    const entries = [{ entryDate: "2026-05-04", hours: 16, isInvoiced: false }];
    const r = calcRoleBudgetReconciliation(5, bookings, entries);
    expect(r.reservedDays).toBe(0);
    expect(r.loggedDays).toBe(2);
  });
});
