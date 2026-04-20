import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addDays,
  addWeeks,
  differenceInDays,
  format,
  getISODay,
  parseISO,
  startOfWeek,
} from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { CalendarRange, ChevronLeft, ChevronRight, Plus, AlertTriangle } from "lucide-react";
import {
  useListEmployees,
  getListEmployeesQueryKey,
  useListProjects,
  getListProjectsQueryKey,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  useListHolidays,
  getListHolidaysQueryKey,
} from "@workspace/api-client-react";
import { resolveProjectColor } from "@workspace/api-zod";

// ── Types ──────────────────────────────────────────────────────────────────────
interface ProjectRole {
  id: number;
  name: string;
  dayRate: number;
  budgetedDays: number | null;
}

interface ResourceBookingFull {
  id: number;
  employeeId: number;
  projectId: number;
  projectRoleId: number | null;
  projectRoleName: string | null;
  dayRate: number | null;
  startDate: string;
  endDate: string;
  hoursPerWeek: number;
  notes: string | null;
  employeeName: string;
  weeklyCapacityHours: number;
  projectName: string;
  clientName: string | null;
  projectColor: string;
}

type AllocUnit = "hours" | "days" | "percent";
type ZoomLevel = "month" | "quarter";

const CELL_WIDTH: Record<ZoomLevel, number> = { month: 80, quarter: 50 };
const NUM_WEEKS: Record<ZoomLevel, number> = { month: 13, quarter: 26 };
const EMPLOYEE_COL = 240;

// ── API hooks ──────────────────────────────────────────────────────────────────
function useResourceBookings() {
  return useQuery<ResourceBookingFull[]>({
    queryKey: ["resource-bookings"],
    queryFn: async () => {
      const res = await fetch("/api/resource-bookings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load resource bookings");
      return res.json();
    },
  });
}

function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: object) => {
      const res = await fetch("/api/resource-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create booking");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["resource-bookings"] }),
  });
}

function useUpdateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: object }) => {
      const res = await fetch(`/api/resource-bookings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update booking");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["resource-bookings"] }),
  });
}

function useDeleteBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete booking");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["resource-bookings"] }),
  });
}

// ── Date utils ─────────────────────────────────────────────────────────────────
function getMondayOfWeek(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

function getBarBounds(
  startDateStr: string,
  endDateStr: string,
  windowStart: Date,
  numWeeks: number,
  cellWidth: number
): { left: number; width: number } | null {
  const start = parseISO(startDateStr);
  const end = addDays(parseISO(endDateStr), 1); // exclusive
  const windowEnd = addDays(windowStart, numWeeks * 7);

  const visibleStart = start < windowStart ? windowStart : start;
  const visibleEnd = end > windowEnd ? windowEnd : end;
  if (visibleStart >= visibleEnd) return null;

  const dayWidth = cellWidth / 7;
  const startOffset = differenceInDays(visibleStart, windowStart);
  const duration = differenceInDays(visibleEnd, visibleStart);
  return { left: startOffset * dayWidth, width: Math.max(duration * dayWidth, 6) };
}

function getMonthGroups(weeks: Date[]): { label: string; count: number }[] {
  const groups: { label: string; count: number }[] = [];
  for (const week of weeks) {
    const label = format(week, "MMM yyyy");
    if (!groups.length || groups[groups.length - 1].label !== label) {
      groups.push({ label, count: 1 });
    } else {
      groups[groups.length - 1].count++;
    }
  }
  return groups;
}

function computeHoursPerWeek(value: number, unit: AllocUnit, capacity: number): number {
  if (unit === "hours") return value;
  if (unit === "days") return value * 8;
  return (value / 100) * capacity;
}

function totalWeeks(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = parseISO(start);
  const e = parseISO(end);
  if (e < s) return 0;
  return Math.ceil((differenceInDays(e, s) + 1) / 7);
}

// ── Working-day utilities ──────────────────────────────────────────────────────
type VacationRange = { startDate: string; endDate: string };

function countBookableDays(
  start: Date,
  end: Date,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[]
): { workingDays: number; holidayCount: number; vacationCount: number; bookableDays: number } {
  let workingDays = 0, holidayCount = 0, vacationCount = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const ds = format(d, "yyyy-MM-dd");
    if (!mask[getISODay(d) - 1]) continue;
    workingDays++;
    if (holidayDates.has(ds)) { holidayCount++; continue; }
    if (vacations.some(v => v.startDate <= ds && ds <= v.endDate)) vacationCount++;
  }
  return { workingDays, holidayCount, vacationCount, bookableDays: workingDays - holidayCount - vacationCount };
}

function addBookableDays(
  start: Date,
  targetDays: number,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[]
): Date {
  let counted = 0;
  let d = new Date(start);
  while (counted < targetDays) {
    d = addDays(d, 1);
    const ds = format(d, "yyyy-MM-dd");
    if (!mask[getISODay(d) - 1]) continue;
    if (holidayDates.has(ds)) continue;
    if (vacations.some(v => v.startDate <= ds && ds <= v.endDate)) continue;
    counted++;
  }
  return d;
}

// ── Booking Modal ──────────────────────────────────────────────────────────────
interface ModalState {
  mode: "create";
  employeeId: number;
  employeeName: string;
  capacity: number;
  workingDaysMask: number[];
  holidayCalendarCode: string | null;
}
interface EditModalState {
  mode: "edit";
  booking: ResourceBookingFull;
  capacity: number;
  workingDaysMask: number[];
  holidayCalendarCode: string | null;
}

type AnyModalState = ModalState | EditModalState;

interface BookingModalProps {
  state: AnyModalState;
  projects: Array<{ id: number; name: string; clientName: string | null; active: boolean }>;
  allBookings: ResourceBookingFull[];
  employees: Array<{ id: number; name: string; weeklyCapacityHours: number }>;
  onClose: () => void;
}

function BookingModal({ state, projects, allBookings, employees, onClose }: BookingModalProps) {
  const { toast } = useToast();
  const createMut = useCreateBooking();
  const updateMut = useUpdateBooking();
  const deleteMut = useDeleteBooking();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEdit = state.mode === "edit";
  const defaultProject = isEdit ? String(state.booking.projectId) : "";
  const defaultStart = isEdit ? state.booking.startDate : "";
  const defaultEnd = isEdit ? state.booking.endDate : "";

  function parseAllocFromHours(h: number, unit: AllocUnit, cap: number) {
    if (unit === "hours") return String(h);
    if (unit === "days") return String(h / 8);
    return String(cap > 0 ? Math.round((h / cap) * 100) : 0);
  }

  const [projectId, setProjectId] = useState(defaultProject);
  const [roleId, setRoleId] = useState<string>(
    isEdit && state.booking.projectRoleId ? String(state.booking.projectRoleId) : ""
  );
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [allocUnit, setAllocUnit] = useState<AllocUnit>("hours");
  const [allocValue, setAllocValue] = useState(
    isEdit ? parseAllocFromHours(state.booking.hoursPerWeek, "hours", state.capacity) : ""
  );
  const [notes, setNotes] = useState(isEdit ? (state.booking.notes ?? "") : "");
  const [calcMode, setCalcMode] = useState<"endDate" | "totalDays">("endDate");
  const [totalDaysValue, setTotalDaysValue] = useState("");

  // Reset totalDaysValue when switching modes
  useEffect(() => {
    setTotalDaysValue("");
  }, [calcMode]);

  // Fetch roles for the selected project
  const { data: projectRoles, isLoading: rolesLoading } = useQuery<ProjectRole[]>({
    queryKey: ["project-roles", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/roles`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch roles");
      return res.json();
    },
    enabled: !!projectId,
  });

  // Clear role when project changes (unless editing and same project)
  const prevProjectId = useRef(projectId);
  if (prevProjectId.current !== projectId) {
    prevProjectId.current = projectId;
    setRoleId("");
  }

  const employeeId = isEdit ? state.booking.employeeId : (state as ModalState).employeeId;
  const capacity = state.capacity;
  const workingDaysMask = state.workingDaysMask;
  const holidayCalendarCode = state.holidayCalendarCode;

  // ── Holiday calendar resolution ─────────────────────────────────────────────
  const { data: holidayCalendars } = useListHolidayCalendars({
    query: {
      queryKey: getListHolidayCalendarsQueryKey(),
      enabled: !!holidayCalendarCode,
    },
  });
  const calendarId = useMemo(() => {
    if (!holidayCalendarCode || !holidayCalendars) return null;
    return (holidayCalendars as any[]).find((c) => c.code === holidayCalendarCode)?.id ?? null;
  }, [holidayCalendarCode, holidayCalendars]);

  // ── Holidays (covers both years when booking spans year boundary) ────────────
  const startYear = startDate ? parseInt(startDate.slice(0, 4)) : new Date().getFullYear();
  // In totalDays mode endDate may be empty; always also fetch startYear+1 to cover year boundaries
  const endYear = endDate ? parseInt(endDate.slice(0, 4)) : startYear + 1;

  const { data: holidaysStartYear } = useListHolidays(
    calendarId ?? 0,
    { year: startYear },
    { query: { queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: startYear }), enabled: !!calendarId } }
  );
  const { data: holidaysEndYear } = useListHolidays(
    calendarId ?? 0,
    { year: endYear },
    { query: { queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: endYear }), enabled: !!calendarId && endYear !== startYear } }
  );
  const holidays = useMemo(() => [
    ...((holidaysStartYear as any[]) ?? []),
    ...(endYear !== startYear ? ((holidaysEndYear as any[]) ?? []) : []),
  ], [holidaysStartYear, holidaysEndYear, endYear, startYear]);

  const holidayDates = useMemo(() =>
    new Set(holidays.map((h: any) => String(h.date).slice(0, 10))),
    [holidays]
  );

  // ── Vacations ───────────────────────────────────────────────────────────────
  const { data: vacations = [] } = useQuery<VacationRange[]>({
    queryKey: ["vacations", employeeId],
    queryFn: async () => {
      const r = await fetch(`/api/vacations?employeeId=${employeeId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch vacations");
      return r.json();
    },
    enabled: !!employeeId,
  });

  // ── Project budget (for role budget info) ───────────────────────────────────
  const { data: projectBudget } = useQuery<any>({
    queryKey: ["project-budget", projectId],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/budget`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch budget");
      return r.json();
    },
    enabled: !!projectId,
  });

  // ── Total Days mode: compute end date ───────────────────────────────────────
  const computedEndDate = useMemo(() => {
    if (calcMode !== "totalDays" || !startDate || !totalDaysValue) return null;
    const target = parseFloat(totalDaysValue);
    if (isNaN(target) || target <= 0) return null;

    // Derive hours-per-week from current allocation inputs (hoursPerWeek is declared later)
    const allocVal = parseFloat(allocValue);
    if (isNaN(allocVal) || allocVal <= 0) return null;
    const hpw = computeHoursPerWeek(allocVal, allocUnit, capacity);
    if (hpw <= 0) return null;

    // Convert project days → calendar working days
    // daysPerWeek = hpw / 8  (1 day = 8 h)
    // normalWorkingDays = number of working days in the employee's week mask
    // calendarWorkingDays = target * normalWorkingDays / daysPerWeek
    //   e.g. 50 project days at 1 day/week (5-day mask) → 50 * 5 / 1 = 250 working days ≈ 50 weeks
    const daysPerWeek = hpw / 8;
    const normalWorkingDays = workingDaysMask.reduce((a: number, b: number) => a + b, 0) || 5;
    const calendarWorkingDays = Math.round(target * normalWorkingDays / daysPerWeek);

    return addBookableDays(parseISO(startDate), calendarWorkingDays, workingDaysMask, holidayDates, vacations);
  }, [calcMode, startDate, totalDaysValue, allocValue, allocUnit, capacity, workingDaysMask, holidayDates, vacations]);

  const effectiveEndDate = calcMode === "totalDays"
    ? (computedEndDate ? format(computedEndDate, "yyyy-MM-dd") : "")
    : endDate;

  // ── Booking summary ─────────────────────────────────────────────────────────
  const bookingSummary = useMemo(() => {
    if (!startDate || !effectiveEndDate || effectiveEndDate < startDate) return null;
    const counts = countBookableDays(
      parseISO(startDate), parseISO(effectiveEndDate),
      workingDaysMask, holidayDates, vacations
    );
    const roleBudget = roleId && projectBudget?.roles
      ? projectBudget.roles.find((r: any) => r.id === parseInt(roleId))
      : null;
    return { ...counts, roleBudget };
  }, [startDate, effectiveEndDate, workingDaysMask, holidayDates, vacations, roleId, projectBudget]);

  // ── Allocation computation ──────────────────────────────────────────────────
  const hoursPerWeek = useMemo(() => {
    const v = parseFloat(allocValue);
    if (isNaN(v) || v <= 0) return 0;
    return computeHoursPerWeek(v, allocUnit, capacity);
  }, [allocValue, allocUnit, capacity]);

  const weeks = totalWeeks(startDate, effectiveEndDate);
  const totalHours = weeks * hoursPerWeek;

  const isOverbooked = useMemo(() => {
    if (!startDate || !effectiveEndDate || hoursPerWeek <= 0) return false;
    const excludeId = isEdit ? state.booking.id : undefined;
    const empBookings = allBookings.filter(
      (b) => b.employeeId === employeeId && b.id !== excludeId
    );
    const s = parseISO(startDate);
    const e = parseISO(effectiveEndDate);
    const nw = Math.ceil((differenceInDays(e, s) + 1) / 7);
    for (let i = 0; i < nw; i++) {
      const ws = addWeeks(getMondayOfWeek(s), i);
      const we = addDays(ws, 7);
      const used = empBookings.reduce((sum, b) => {
        const bs = parseISO(b.startDate);
        const be = addDays(parseISO(b.endDate), 1);
        return bs < we && be > ws ? sum + b.hoursPerWeek : sum;
      }, 0);
      if (used + hoursPerWeek > capacity) return true;
    }
    return false;
  }, [startDate, effectiveEndDate, hoursPerWeek, allBookings, employeeId, capacity, isEdit, state]);

  // A role must be selected if the project has roles
  const rolesAvailable = projectRoles !== undefined;
  const hasRoles = rolesAvailable && projectRoles.length > 0;
  const roleRequired = !!projectId && hasRoles;

  const canSubmit =
    projectId &&
    (!roleRequired || roleId) &&
    startDate &&
    effectiveEndDate &&
    startDate <= effectiveEndDate &&
    hoursPerWeek > 0 &&
    !createMut.isPending &&
    !updateMut.isPending;

  async function handleSubmit() {
    if (!canSubmit) return;
    const payload = {
      employeeId,
      projectId: parseInt(projectId, 10),
      projectRoleId: roleId ? parseInt(roleId, 10) : null,
      startDate,
      endDate: effectiveEndDate,
      hoursPerWeek,
      notes: notes.trim() || null,
    };
    try {
      if (isEdit) {
        await updateMut.mutateAsync({ id: state.booking.id, data: payload });
        toast({ title: "Booking updated" });
      } else {
        await createMut.mutateAsync(payload);
        toast({ title: "Booking created" });
      }
      onClose();
    } catch {
      toast({ title: "Failed to save booking", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    try {
      await deleteMut.mutateAsync(state.booking.id);
      toast({ title: "Booking deleted" });
      onClose();
    } catch {
      toast({ title: "Failed to delete booking", variant: "destructive" });
    }
  }

  const empName = isEdit
    ? state.booking.employeeName
    : (state as ModalState).employeeName;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit booking" : "New booking"} — {empName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Project */}
          <div className="space-y-1.5">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select project…" />
              </SelectTrigger>
              <SelectContent>
                {projects.filter((p) => p.active).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span className="truncate block max-w-[380px]" title={`${p.name}${p.clientName ? ` (${p.clientName})` : ""}`}>
                      {p.name}{p.clientName ? ` (${p.clientName})` : ""}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Role — shown once a project is selected */}
          {projectId && (
            <div className="space-y-1.5">
              <Label>Role</Label>
              {rolesLoading ? (
                <div className="h-10 rounded-md border bg-muted/50 animate-pulse" />
              ) : !hasRoles ? (
                <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                  No roles defined for this project
                </div>
              ) : (
                <Select value={roleId} onValueChange={setRoleId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectRoles!.map((r) => {
                      const label = r.name + (r.dayRate > 0 ? ` — €${r.dayRate.toLocaleString("de-DE")}/day` : "");
                      return (
                        <SelectItem key={r.id} value={String(r.id)}>
                          <span className="truncate block max-w-[380px]" title={label}>{label}</span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Calculate-by toggle */}
          <div className="space-y-1.5">
            <Label>Calculate by</Label>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(["endDate", "totalDays"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setCalcMode(mode)}
                  className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
                    calcMode === mode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode === "endDate" ? "End date" : "Total days"}
                </button>
              ))}
            </div>
          </div>

          {/* Date / Total days section */}
          {calcMode === "endDate" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start date</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>End date</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Start date</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Total days</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 50"
                  value={totalDaysValue}
                  onChange={(e) => setTotalDaysValue(e.target.value)}
                />
              </div>
              {totalDaysValue && parseFloat(totalDaysValue) > 0 && (
                computedEndDate ? (
                  <p className="text-sm text-muted-foreground">
                    Estimated end date:{" "}
                    <span className="font-medium text-foreground">
                      {format(computedEndDate, "d. MMM yyyy")}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Set the allocation below to compute the end date.
                  </p>
                )
              )}
            </div>
          )}

          {/* Allocation */}
          <div className="space-y-1.5">
            <Label>Allocation</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={0}
                step={allocUnit === "hours" ? 0.5 : allocUnit === "days" ? 0.5 : 5}
                className="flex-1"
                placeholder={allocUnit === "percent" ? "e.g. 50" : allocUnit === "days" ? "e.g. 2" : "e.g. 8"}
                value={allocValue}
                onChange={(e) => setAllocValue(e.target.value)}
              />
              <Select value={allocUnit} onValueChange={(v) => setAllocUnit(v as AllocUnit)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">hours/week</SelectItem>
                  <SelectItem value="days">days/week</SelectItem>
                  <SelectItem value="percent">%</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              placeholder="Internal notes…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* Booking summary */}
          {bookingSummary && (
            <div className="rounded-md bg-muted/50 border border-border px-3 py-2 text-sm space-y-1">
              <div className="font-medium text-foreground mb-1">Booking summary</div>
              <div className="flex justify-between text-muted-foreground">
                <span>Working days in period</span>
                <span className="font-medium text-foreground">{bookingSummary.workingDays}d</span>
              </div>
              {bookingSummary.holidayCount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Public holidays</span>
                  <span>−{bookingSummary.holidayCount}d</span>
                </div>
              )}
              {bookingSummary.vacationCount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Vacations / absences</span>
                  <span>−{bookingSummary.vacationCount}d</span>
                </div>
              )}
              <div className="border-t border-border/60 pt-1 flex justify-between font-medium">
                <span>Bookable days</span>
                <span className="text-foreground">{bookingSummary.bookableDays}d</span>
              </div>
              {bookingSummary.roleBudget?.budgetedDays != null && (
                <>
                  <div className="border-t border-border/60 pt-1" />
                  <div className="flex justify-between text-muted-foreground">
                    <span>Role budget</span>
                    <span>{bookingSummary.roleBudget.budgetedDays}d</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Already planned</span>
                    <span>−{bookingSummary.roleBudget.plannedDays ?? 0}d</span>
                  </div>
                  <div className={`flex justify-between font-medium ${
                    (bookingSummary.roleBudget.remainingDays ?? 0) < 0 ? "text-destructive" : ""
                  }`}>
                    <span>Remaining</span>
                    <span>{bookingSummary.roleBudget.remainingDays ?? 0}d</span>
                  </div>
                </>
              )}
              {hoursPerWeek > 0 && (
                <div className="border-t border-border/60 pt-1 text-muted-foreground text-xs">
                  {hoursPerWeek.toFixed(1)}h/week · {weeks} week{weeks !== 1 ? "s" : ""} · {totalHours.toFixed(0)}h total
                </div>
              )}
            </div>
          )}

          {/* Overbooking warning */}
          {isOverbooked && (
            <div className="flex items-start gap-2 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>This booking will cause overbooking in some weeks.</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between pt-2">
          {isEdit && !confirmDelete && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete booking
            </Button>
          )}
          {isEdit && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Are you sure?</span>
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteMut.isPending}>
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          )}
          {!confirmDelete && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {createMut.isPending || updateMut.isPending
                  ? "Saving…"
                  : isEdit
                  ? "Save changes"
                  : "Create booking"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function ResourcePlannerPage() {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [windowStart, setWindowStart] = useState(() => getMondayOfWeek(today));
  const [zoom, setZoom] = useState<ZoomLevel>("month");
  const [modal, setModal] = useState<AnyModalState | null>(null);

  const cellWidth = CELL_WIDTH[zoom];
  const numWeeks = NUM_WEEKS[zoom];

  const weeks = useMemo(
    () => Array.from({ length: numWeeks }, (_, i) => addWeeks(windowStart, i)),
    [windowStart, numWeeks]
  );
  const monthGroups = useMemo(() => getMonthGroups(weeks), [weeks]);

  const windowEnd = addDays(windowStart, numWeeks * 7);

  // Today marker
  const todayInRange = today >= windowStart && today < windowEnd;
  const todayOffset = todayInRange
    ? (differenceInDays(today, windowStart) / 7) * cellWidth
    : null;

  // Data
  const { data: employees = [] } = useListEmployees(
    { includeInactive: false },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: false }) } }
  );
  const { data: projects = [] } = useListProjects(
    { includeInactive: false },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) } }
  );
  const { data: bookings = [], isLoading: bookingsLoading } = useResourceBookings();

  const bookingsByEmployee = useMemo(() => {
    const map: Record<number, ResourceBookingFull[]> = {};
    for (const b of bookings) {
      (map[b.employeeId] ??= []).push(b);
    }
    return map;
  }, [bookings]);

  const getWeekUsage = useCallback(
    (employeeId: number, weekStart: Date): number => {
      const weekEnd = addDays(weekStart, 7);
      return (bookingsByEmployee[employeeId] ?? []).reduce((sum, b) => {
        const bs = parseISO(b.startDate);
        const be = addDays(parseISO(b.endDate), 1);
        return bs < weekEnd && be > weekStart ? sum + b.hoursPerWeek : sum;
      }, 0);
    },
    [bookingsByEmployee]
  );

  function openCreateModal(emp: typeof employees[number]) {
    const e = emp as any;
    setModal({
      mode: "create",
      employeeId: e.id,
      employeeName: e.name,
      capacity: e.weeklyCapacityHours ?? 40,
      workingDaysMask: Array.isArray(e.workingDaysMask) ? e.workingDaysMask : [1,1,1,1,1,0,0],
      holidayCalendarCode: e.holidayCalendarCode ?? null,
    });
  }

  function openEditModal(b: ResourceBookingFull) {
    const emp = (employees as any[]).find((e) => e.id === b.employeeId);
    setModal({
      mode: "edit",
      booking: b,
      capacity: b.weeklyCapacityHours,
      workingDaysMask: Array.isArray(emp?.workingDaysMask) ? emp.workingDaysMask : [1,1,1,1,1,0,0],
      holidayCalendarCode: emp?.holidayCalendarCode ?? null,
    });
  }

  const contentWidth = numWeeks * cellWidth;

  const activeEmployees = (employees as any[]).filter((e) => e.active !== false);

  // Window label
  const windowLabel = useMemo(() => {
    const startLabel = format(windowStart, "MMM yyyy");
    const endLabel = format(addWeeks(windowStart, numWeeks - 1), "MMM yyyy");
    return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
  }, [windowStart, numWeeks]);

  return (
    <AdminLayout>
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card shrink-0 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <CalendarRange className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Resource Planner</h1>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWindowStart((prev) => addWeeks(prev, -4))}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-sm font-medium w-40 text-center">{windowLabel}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWindowStart((prev) => addWeeks(prev, 4))}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowStart(getMondayOfWeek(today))}
          >
            Today
          </Button>
        </div>

        <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
          {(["month", "quarter"] as ZoomLevel[]).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={`px-3 py-1 text-xs rounded font-medium capitalize transition-colors ${
                zoom === z
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {z === "month" ? "Month" : "Quarter"}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-border text-xs text-muted-foreground shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-green-200 dark:bg-green-900/50 border border-green-300" />
          <span>&lt;80%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-yellow-200 dark:bg-yellow-900/50 border border-yellow-300" />
          <span>80–100%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-red-200 dark:bg-red-900/50 border border-red-300" />
          <span>&gt;100% overbooked</span>
        </div>
        {todayInRange && (
          <div className="flex items-center gap-1.5">
            <div className="w-px h-3 bg-red-500" />
            <span>Today</span>
          </div>
        )}
      </div>

      {/* Planner grid */}
      <div className="flex-1 overflow-auto relative">
        {bookingsLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-50 text-sm text-muted-foreground">
            Loading bookings…
          </div>
        )}

        <div style={{ minWidth: EMPLOYEE_COL + contentWidth }}>
          {/* ── Sticky header ── */}
          <div className="sticky top-0 z-20 flex bg-card border-b border-border">
            {/* People header cell */}
            <div
              className="sticky left-0 z-30 bg-card border-r border-border flex items-end px-4 pb-2 shrink-0"
              style={{ width: EMPLOYEE_COL, minHeight: 56 }}
            >
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                People
              </span>
            </div>

            {/* Month + week labels */}
            <div style={{ width: contentWidth }}>
              {/* Month row */}
              <div className="flex border-b border-border/50 bg-muted/30">
                {monthGroups.map((m, i) => (
                  <div
                    key={i}
                    className="shrink-0 px-2 py-1 text-xs font-semibold text-muted-foreground border-r border-border/50 last:border-r-0"
                    style={{ width: m.count * cellWidth }}
                  >
                    {m.label}
                  </div>
                ))}
              </div>
              {/* Week row */}
              <div className="flex relative">
                {weeks.map((w, i) => (
                  <div
                    key={i}
                    className="shrink-0 border-r border-border/40 last:border-r-0 flex flex-col items-center justify-center py-1"
                    style={{ width: cellWidth }}
                  >
                    <span className="text-xs font-medium text-foreground/70">
                      {format(w, "d")}
                    </span>
                    {zoom === "month" && (
                      <span className="text-[10px] text-muted-foreground/60">
                        {format(w, "MMM")}
                      </span>
                    )}
                  </div>
                ))}
                {/* Today header marker */}
                {todayOffset !== null && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-red-500 z-10 pointer-events-none"
                    style={{ left: todayOffset }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ── Employee rows ── */}
          {activeEmployees.length === 0 && (
            <div className="py-12 text-center text-muted-foreground text-sm">
              No active employees found.
            </div>
          )}

          {activeEmployees.map((emp: any) => {
            const empBookings = bookingsByEmployee[emp.id] ?? [];
            const cap: number = emp.weeklyCapacityHours ?? 40;

            return (
              <div
                key={emp.id}
                className="flex border-b border-border group"
                style={{ minHeight: 64 }}
              >
                {/* Employee info — sticky left */}
                <div
                  className="sticky left-0 z-10 bg-card border-r border-border shrink-0 flex flex-col justify-between px-4 py-2"
                  style={{ width: EMPLOYEE_COL }}
                >
                  <div>
                    <div className="text-sm font-medium truncate">{emp.name}</div>
                    <div className="text-xs text-muted-foreground">{cap}h/week</div>
                  </div>
                  <button
                    onClick={() => openCreateModal(emp)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors w-fit mt-1"
                  >
                    <Plus className="h-3 w-3" />
                    Booking
                  </button>
                </div>

                {/* Timeline area */}
                <div className="relative flex-1" style={{ width: contentWidth, minHeight: 64 }}>
                  {/* Capacity cells */}
                  <div className="flex h-full absolute inset-0">
                    {weeks.map((w, i) => {
                      const used = getWeekUsage(emp.id, w);
                      const pct = cap > 0 ? used / cap : 0;
                      const bg =
                        pct > 1
                          ? "bg-red-100 dark:bg-red-950/40"
                          : pct >= 0.8
                          ? "bg-yellow-100 dark:bg-yellow-950/30"
                          : pct > 0
                          ? "bg-green-100 dark:bg-green-950/20"
                          : "";
                      return (
                        <div
                          key={i}
                          className={`shrink-0 border-r border-border/30 last:border-r-0 ${bg}`}
                          style={{ width: cellWidth, height: "100%" }}
                        />
                      );
                    })}
                  </div>

                  {/* Booking bars */}
                  {empBookings.map((b) => {
                    const bounds = getBarBounds(
                      b.startDate,
                      b.endDate,
                      windowStart,
                      numWeeks,
                      cellWidth
                    );
                    if (!bounds) return null;
                    const color = resolveProjectColor(b.projectId, b.projectColor);

                    const barLabel = b.projectRoleName
                      ? `${b.projectName} – ${b.projectRoleName}`
                      : b.projectName;
                    const charBudget = Math.floor(bounds.width / 7);

                    return (
                      <Tooltip key={b.id}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute cursor-pointer rounded-md flex items-center px-2 text-white text-xs font-medium overflow-hidden shadow-sm hover:brightness-90 transition-all"
                            style={{
                              top: 8,
                              height: 40,
                              left: bounds.left,
                              width: bounds.width,
                              backgroundColor: color,
                            }}
                            onClick={() => openEditModal(b)}
                          >
                            {bounds.width > 40
                              ? barLabel.length <= charBudget
                                ? barLabel
                                : barLabel.slice(0, charBudget - 1) + "…"
                              : ""}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs space-y-0.5 max-w-[240px]">
                          <div className="font-semibold">{b.projectName}</div>
                          {b.clientName && (
                            <div className="text-muted-foreground">{b.clientName}</div>
                          )}
                          {b.projectRoleName && (
                            <div className="text-primary font-medium">
                              {b.projectRoleName}
                              {b.dayRate ? ` — €${b.dayRate.toLocaleString("de-DE")}/day` : ""}
                            </div>
                          )}
                          <div>{b.hoursPerWeek.toFixed(1)}h/week</div>
                          <div>
                            {format(parseISO(b.startDate), "MMM d")} –{" "}
                            {format(parseISO(b.endDate), "MMM d, yyyy")}
                          </div>
                          <div>
                            Total:{" "}
                            {(totalWeeks(b.startDate, b.endDate) * b.hoursPerWeek).toFixed(0)}h
                          </div>
                          {b.notes && (
                            <div className="text-muted-foreground italic">{b.notes}</div>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}

                  {/* Today line in row */}
                  {todayOffset !== null && (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-red-500/60 pointer-events-none z-10"
                      style={{ left: todayOffset }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Booking modal */}
      {modal && (
        <BookingModal
          state={modal}
          projects={projects as any[]}
          allBookings={bookings}
          employees={activeEmployees}
          onClose={() => setModal(null)}
        />
      )}
    </div>
    </AdminLayout>
  );
}
