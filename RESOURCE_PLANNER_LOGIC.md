# Resource Planner — working logic & terms

A plain-language guide to how slots and the role budget work, matching the
definitions in `replit.md` (§ Business Logic & Formulae → Resource Bookings)
and the code in `artifacts/api-server/src/lib/budget-reconciliation.ts` and
`booking-hours.ts`. The booking modal now mirrors these terms exactly.

## The unit: everything is in 8-hour days

`8 hours = 1 day`. Every budget number you see is an **8h-day equivalent**:

```
budgetDays = totalHours / 8
```

A slot's hours can be **flat** (same `hoursPerDay` every working day) or
**per-weekday** (a Mon–Fri map). Either way, a day only counts if it is a
working day for that employee and **not** a weekend, public holiday, vacation,
or comp day. That single rule lives in `calcDayHours`.

## A "slot" = one resource booking

A **slot** is one booking: an employee, on one project **role**, for a date
range, at some hours/day. You can give the same employee several slots on the
same role (e.g. part-time now, full-time later). **All slots on a role draw
from the same role budget** — that is why the next slot you add "depends on"
the previous ones: they share the buckets below.

## The budget buckets (the core identity)

For each role:

```
Budgeted = Invoiced + Re-plannable + Unplanned
```

| Term            | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| **Budgeted**    | Days budgeted for the role (set on the role).                           |
| **Planned**     | Days booked across all slots (sum of planned hours ÷ 8).                |
| **Logged**      | Hours actually recorded in timesheets ÷ 8.                              |
| **Invoiced**    | Logged days that have been billed. **Locked** — cannot be re-planned.   |
| **Re-plannable**| Planned but **not yet delivered**: `Σ max(planned − logged, 0)` per day ÷ 8. Movable. (a.k.a. "Reserved".) |
| **Unplanned**   | `Budgeted − Invoiced − Re-plannable`. Budget not yet committed to a plan.|
| **Free**        | `Budgeted − Logged`.                                                     |
| **Remaining**   | `Budgeted − Invoiced`.                                                   |

Reconciliation is **per-day**: planned and logged hours are bucketed by date so
two overlapping slots on the same day are never double-counted. Undelivered =
`max(planned − logged, 0)` for that day.

### Adding a slot

A new slot consumes **Unplanned**:

```
Unplanned after this slot = Unplanned − (this slot's days)
```

If that goes below 0, the slot exceeds the unplanned budget — the modal warns
and offers three options: reduce the slot, release past undelivered plan, or
increase the role budget.

## "Release past undelivered plan" — today is the reference

Plain meaning: a planned day **in the past** that was never logged still
silently holds budget. **Releasing** frees that stale reservation.

- **Today** (the server's current date) is the dividing line. (`new Date()`
  in `calcRoleBudgetReconciliation`, `/past-undelivered`, and
  `release-past-bulk`.)
- For a **released** slot, planned hours for days **strictly before today** are
  excluded; days **on/after today** still count normally.
- **Logged and invoiced work are never changed.** Release is fully
  **reversible** (Undo release).

So a mid-flight slot that is released frees only its past undelivered gap; its
future plan stays reserved.

## How the redesigned modal shows all this

Opening **any** slot shows the same picture, split into two clearly separated
parts:

1. **This slot** — the booking you opened: dates, hours pattern, bookable days,
   and the days it books against the role budget. Plus a **past vs. future**
   panel anchored to *today* with the per-slot **"Release N d past undelivered
   plan"** button (the day count is on the button), or the released state with
   **Undo**.

2. **Role budget (shared by every slot)** — identical no matter which slot you
   open: Budgeted / Logged / Invoiced / Re-plannable / Unplanned / Free /
   Remaining, the effect of this slot (Unplanned after this slot), a list of
   **every slot for this employee on the role** (with a "released" marker and
   the current slot highlighted), all employees on the role, and a short legend
   of the terms above.

This is why mirroring is *not* confusing: the role-wide facts are shown once, in
one shared block, while the thing that changes per slot lives in its own block.
