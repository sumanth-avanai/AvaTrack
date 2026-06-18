import { useState, useMemo, useRef, useEffect } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useQuery,
  useQueries,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Plus,
  AlertTriangle,
  X,
  ArrowUpDown,
  Check,
  ChevronDown,
  Filter,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  assignedEmployees: { employeeId: number; employeeName: string | null }[];
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
  hoursPerDay: number;
  weekdayHours: Record<string, number> | null;
  notes: string | null;
  employeeName: string;
  weeklyCapacityHours: number;
  projectName: string;
  clientName: string | null;
  projectColor: string;
}
type ZoomLevel = "month" | "quarter" | "year";
type SortMode = "alpha-asc" | "alpha-desc" | "alloc-desc" | "alloc-asc";

const CELL_WIDTH: Record<ZoomLevel, number> = {
  month: 80,
  quarter: 50,
  year: 18,
};
const NUM_WEEKS: Record<ZoomLevel, number> = {
  month: 13,
  quarter: 26,
  year: 52,
};
const NAV_WEEKS: Record<ZoomLevel, number> = {
  month: 4,
  quarter: 13,
  year: 26,
};
const EMPLOYEE_COL = 200;
const ROW_HEIGHT = 40;

// ── Bar stacking helpers ────────────────────────────────────────────────────────
const BAR_H_SINGLE = 22;
const BAR_H_STACKED = 16;
const BAR_GAP = 2;
const BAR_PAD_TOP = 4;
const MAX_VISIBLE_LANES = 3;

function assignLanes(
  bookings: ResourceBookingFull[],
): (ResourceBookingFull & { lane: number })[] {
  const sorted = [...bookings].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
  const laneEnds: string[] = [];
  return sorted.map((b) => {
    let laneIdx = laneEnds.findIndex((endDate) => b.startDate > endDate);
    if (laneIdx === -1) {
      laneIdx = laneEnds.length;
    }
    laneEnds[laneIdx] = b.endDate;
    return { ...b, lane: laneIdx };
  });
}

function calcRowHeight(laneCount: number): number {
  if (laneCount <= 1) return ROW_HEIGHT;
  const visible = Math.min(laneCount, MAX_VISIBLE_LANES);
  const hasMore = laneCount > MAX_VISIBLE_LANES;
  return Math.max(
    ROW_HEIGHT,
    BAR_PAD_TOP +
      visible * BAR_H_STACKED +
      (visible - 1) * BAR_GAP +
      BAR_PAD_TOP +
      (hasMore ? 16 : 0),
  );
}

function darkenColor(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return hex;
  const [r, g, b] = [0, 2, 4].map((i) =>
    Math.max(0, parseInt(c.slice(i, i + 2), 16) - 50),
  );
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ── API hooks ──────────────────────────────────────────────────────────────────
function useResourceBookings() {
  return useQuery<ResourceBookingFull[]>({
    queryKey: ["resource-bookings"],
    queryFn: async () => {
      const res = await fetch("/api/resource-bookings", {
        credentials: "include",
      });
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useCreateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: object) => {
      const res = await fetch("/api/vacations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create vacation");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
  });
}

function useUpdateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: object }) => {
      const res = await fetch(`/api/vacations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update vacation");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
  });
}

function useDeleteVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/vacations/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete vacation");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
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
  cellWidth: number,
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
  return {
    left: startOffset * dayWidth,
    width: Math.max(duration * dayWidth, 6),
  };
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

function countWeekdaysBetween(start: string, end: string): number {
  if (!start || !end || end < start) return 0;
  const s = parseISO(start);
  const e = parseISO(end);
  const totalDays = differenceInDays(e, s) + 1;
  const fullWeeks = Math.floor(totalDays / 7);
  const remaining = totalDays % 7;
  let weekdays = fullWeeks * 5;
  const startDow = s.getDay();
  for (let i = 0; i < remaining; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) weekdays++;
  }
  return weekdays;
}

// Count working days (per employee mask) between two ISO date strings, inclusive
function countMaskDaysBetween(
  start: string,
  end: string,
  mask: number[],
): number {
  if (!start || !end || end < start) return 0;
  let count = 0;
  const s = parseISO(start);
  const e = parseISO(end);
  for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
    if (mask[getISODay(d) - 1]) count++;
  }
  return count;
}

// ── Working-day utilities ──────────────────────────────────────────────────────
type VacationRange = { startDate: string; endDate: string };

interface VacationEntry {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  vacationType: string;
  note: string | null;
}

interface HolidayEntry {
  id: number;
  calendarId: number;
  date: string;
  name: string;
}

function useAllVacations() {
  return useQuery<VacationEntry[]>({
    queryKey: ["vacations-all"],
    queryFn: async () => {
      const r = await fetch("/api/vacations", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch vacations");
      return r.json();
    },
  });
}

function countBookableDays(
  start: Date,
  end: Date,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): {
  workingDays: number;
  holidayCount: number;
  vacationCount: number;
  bookableDays: number;
} {
  let workingDays = 0,
    holidayCount = 0,
    vacationCount = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const ds = format(d, "yyyy-MM-dd");
    if (!mask[getISODay(d) - 1]) continue;
    workingDays++;
    if (holidayDates.has(ds)) {
      holidayCount++;
      continue;
    }
    if (vacations.some((v) => v.startDate <= ds && ds <= v.endDate))
      vacationCount++;
  }
  return {
    workingDays,
    holidayCount,
    vacationCount,
    bookableDays: workingDays - holidayCount - vacationCount,
  };
}

function addBookableDays(
  start: Date,
  targetDays: number,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): Date {
  let counted = 0;
  let d = new Date(start);
  while (counted < targetDays) {
    d = addDays(d, 1);
    const ds = format(d, "yyyy-MM-dd");
    if (!mask[getISODay(d) - 1]) continue;
    if (holidayDates.has(ds)) continue;
    if (vacations.some((v) => v.startDate <= ds && ds <= v.endDate)) continue;
    counted++;
  }
  return d;
}

// ── Weekday-hours helpers ─────────────────────────────────────────────────────
const DAY_LABELS: Record<string, string> = {
  "1": "Mo",
  "2": "Di",
  "3": "Mi",
  "4": "Do",
  "5": "Fr",
};

const WEEKDAY_PRESETS = [
  { label: "Mo–Fr 8h", hours: { "1": 8, "2": 8, "3": 8, "4": 8, "5": 8 } },
  { label: "Mo–Do 8h", hours: { "1": 8, "2": 8, "3": 8, "4": 8, "5": 0 } },
  { label: "Mo–Fr 4h", hours: { "1": 4, "2": 4, "3": 4, "4": 4, "5": 4 } },
] as const;

function matchesPreset(
  wh: Record<string, number>,
  preset: Record<string, number>,
): boolean {
  return ["1", "2", "3", "4", "5"].every(
    (k) => (wh[k] ?? 0) === (preset[k as keyof typeof preset] ?? 0),
  );
}

function formatWeekdayHours(wh: Record<string, number>): string {
  const slots = ["1", "2", "3", "4", "5"].map((k) => ({
    label: DAY_LABELS[k],
    h: wh[k] ?? 0,
  }));
  const groups: { start: string; end: string; h: number }[] = [];
  let cur: { start: string; end: string; h: number } | null = null;
  for (const { label, h } of slots) {
    if (cur == null || cur.h !== h) {
      if (cur) groups.push(cur);
      cur = { start: label, end: label, h };
    } else {
      cur.end = label;
    }
  }
  if (cur) groups.push(cur);
  return groups
    .map(
      (g) =>
        `${g.start === g.end ? g.start : `${g.start}–${g.end}`} ${g.h % 1 === 0 ? g.h : g.h.toFixed(1)}h`,
    )
    .join(", ");
}

/** Client-side mirror of the backend calcBookingHours helper. */
function calcBookingHoursClient(
  startStr: string,
  endStr: string,
  hoursPerDay: number,
  weekdayHours: Record<string, number> | null,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): { totalHours: number; budgetDays: number } {
  if (!startStr || !endStr || endStr < startStr)
    return { totalHours: 0, budgetDays: 0 };
  const start = parseISO(startStr);
  const end = parseISO(endStr);
  let total = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const ds = format(d, "yyyy-MM-dd");
    const isoIdx = getISODay(d) - 1; // 0=Mon…6=Sun
    if (!mask[isoIdx]) continue;
    if (holidayDates.has(ds)) continue;
    if (vacations.some((v) => v.startDate <= ds && ds <= v.endDate)) continue;
    if (weekdayHours != null) {
      total += weekdayHours[String(d.getDay())] ?? 0; // getDay(): 0=Sun,1=Mon…5=Fri
    } else {
      total += hoursPerDay;
    }
  }
  return { totalHours: total, budgetDays: Math.round((total / 8) * 100) / 100 };
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
  projects: Array<{
    id: number;
    name: string;
    clientName: string | null;
    active: boolean;
  }>;
  allBookings: ResourceBookingFull[];
  employees: Array<{ id: number; name: string; weeklyCapacityHours: number }>;
  onClose: () => void;
}

function BookingModal({
  state,
  projects,
  allBookings,
  employees,
  onClose,
}: BookingModalProps) {
  const { toast } = useToast();
  const createMut = useCreateBooking();
  const updateMut = useUpdateBooking();
  const deleteMut = useDeleteBooking();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEdit = state.mode === "edit";
  const defaultProject = isEdit ? String(state.booking.projectId) : "";
  const defaultStart = isEdit ? state.booking.startDate : "";
  const defaultEnd = isEdit ? state.booking.endDate : "";

  const [projectId, setProjectId] = useState(defaultProject);
  const [roleId, setRoleId] = useState<string>(
    isEdit && state.booking.projectRoleId
      ? String(state.booking.projectRoleId)
      : "",
  );
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [hoursPerDay, setHoursPerDay] = useState<number>(
    isEdit ? state.booking.hoursPerDay : 8,
  );
  const [hoursPerDayInput, setHoursPerDayInput] = useState<string>(
    isEdit ? String(state.booking.hoursPerDay) : "8",
  );
  const [notes, setNotes] = useState(isEdit ? (state.booking.notes ?? "") : "");

  // Weekday mode state — new bookings default to weekday-only mode
  const [weekdayMode, setWeekdayMode] = useState(
    isEdit ? state.booking.weekdayHours != null : true,
  );
  const [weekdayHours, setWeekdayHours] = useState<Record<string, number>>(
    isEdit && state.booking.weekdayHours != null
      ? state.booking.weekdayHours
      : { "1": 8, "2": 8, "3": 8, "4": 8, "5": 8 },
  );

  // Fetch roles for the selected project
  const { data: projectRoles, isLoading: rolesLoading } = useQuery<
    ProjectRole[]
  >({
    queryKey: ["project-roles", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/roles`, {
        credentials: "include",
      });
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

  const employeeId = isEdit
    ? state.booking.employeeId
    : (state as ModalState).employeeId;

  // Partition roles into assigned (for this employee) vs. the rest
  const assignedRoles = useMemo(
    () =>
      (projectRoles ?? []).filter((r) =>
        r.assignedEmployees.some((a) => a.employeeId === employeeId),
      ),
    [projectRoles, employeeId],
  );
  const unassignedRoles = useMemo(
    () =>
      (projectRoles ?? []).filter(
        (r) => !r.assignedEmployees.some((a) => a.employeeId === employeeId),
      ),
    [projectRoles, employeeId],
  );

  // Auto-select when the employee has exactly one assigned role and none is chosen yet
  useEffect(() => {
    if (assignedRoles.length === 1 && !roleId) {
      setRoleId(String(assignedRoles[0].id));
    }
  }, [assignedRoles, roleId]);
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
    return (
      (holidayCalendars as any[]).find((c) => c.code === holidayCalendarCode)
        ?.id ?? null
    );
  }, [holidayCalendarCode, holidayCalendars]);

  // ── Holidays (covers both years when booking spans year boundary) ────────────
  const startYear = startDate
    ? parseInt(startDate.slice(0, 4))
    : new Date().getFullYear();
  // In totalDays mode endDate may be empty; always also fetch startYear+1 to cover year boundaries
  const endYear = endDate ? parseInt(endDate.slice(0, 4)) : startYear + 1;

  const { data: holidaysStartYear } = useListHolidays(
    calendarId ?? 0,
    { year: startYear },
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: startYear }),
        enabled: !!calendarId,
      },
    },
  );
  const { data: holidaysEndYear } = useListHolidays(
    calendarId ?? 0,
    { year: endYear },
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: endYear }),
        enabled: !!calendarId && endYear !== startYear,
      },
    },
  );
  const holidays = useMemo(
    () => [
      ...((holidaysStartYear as any[]) ?? []),
      ...(endYear !== startYear ? ((holidaysEndYear as any[]) ?? []) : []),
    ],
    [holidaysStartYear, holidaysEndYear, endYear, startYear],
  );

  const holidayDates = useMemo(
    () => new Set(holidays.map((h: any) => String(h.date).slice(0, 10))),
    [holidays],
  );

  // ── Vacations ───────────────────────────────────────────────────────────────
  const { data: vacations = [] } = useQuery<VacationRange[]>({
    queryKey: ["vacations", employeeId],
    queryFn: async () => {
      const r = await fetch(`/api/vacations?employeeId=${employeeId}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to fetch vacations");
      return r.json();
    },
    enabled: !!employeeId,
  });

  // ── Role budget status (for live budget validation) ─────────────────────────
  interface RoleBudgetBooking {
    employeeId: number;
    employeeName: string;
    days: number;
    loggedDays: number;
  }
  interface RoleBudgetStatus {
    budgetedDays: number | null;
    plannedDays: number;
    loggedDays: number;
    availableDays: number | null;
    employeeLoggedDays: number | null;
    bookings: RoleBudgetBooking[];
  }
  const excludeBookingId = isEdit ? state.booking.id : undefined;
  const { data: roleBudgetStatus } = useQuery<RoleBudgetStatus>({
    queryKey: [
      "role-budget-status",
      roleId,
      excludeBookingId ?? null,
      employeeId,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (excludeBookingId != null)
        params.set("excludeBookingId", String(excludeBookingId));
      if (employeeId != null) params.set("employeeId", String(employeeId));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const r = await fetch(`/api/project-roles/${roleId}/budget-status${qs}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to fetch role budget");
      return r.json();
    },
    enabled: !!roleId,
  });

  // ── Booking summary ─────────────────────────────────────────────────────────
  const bookingSummary = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    const counts = countBookableDays(
      parseISO(startDate),
      parseISO(endDate),
      workingDaysMask,
      holidayDates,
      vacations,
    );
    return counts;
  }, [startDate, endDate, workingDaysMask, holidayDates, vacations]);

  // Precise hours/budget calculation (weekday-mode aware)
  const calcResult = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    return calcBookingHoursClient(
      startDate,
      endDate,
      hoursPerDay,
      weekdayMode ? weekdayHours : null,
      workingDaysMask,
      holidayDates,
      vacations,
    );
  }, [
    startDate,
    endDate,
    hoursPerDay,
    weekdayMode,
    weekdayHours,
    workingDaysMask,
    holidayDates,
    vacations,
  ]);

  // How many bookable days this booking consumes
  const thisBookingDays = bookingSummary ? bookingSummary.bookableDays : null;
  // Budget is always in 8h-day equivalents
  const thisBookingBudgetDays =
    calcResult && calcResult.totalHours > 0 ? calcResult.budgetDays : null;
  // Total hours
  const totalHours =
    calcResult && calcResult.totalHours > 0 ? calcResult.totalHours : null;

  // Weekday-mode derived values
  const weeklyTotal = weekdayMode
    ? Object.values(weekdayHours).reduce((s, h) => s + h, 0)
    : null;
  const allWeekdayZero = weekdayMode && weeklyTotal === 0;

  const isOverbooked = useMemo(() => {
    if (!startDate || !endDate) return false;
    if (!weekdayMode && hoursPerDay <= 0) return false;
    const excludeId = isEdit ? state.booking.id : undefined;
    const empBookings = allBookings.filter(
      (b) => b.employeeId === employeeId && b.id !== excludeId,
    );
    const s = parseISO(startDate);
    const e = parseISO(endDate);

    // Daily capacity derived from the employee's actual working days
    const activeDaysPerWeek = workingDaysMask.reduce(
      (sum, v) => sum + (v ? 1 : 0),
      0,
    );
    if (activeDaysPerWeek === 0) return false;
    const dailyCapacity = capacity / activeDaysPerWeek;

    const nw = Math.ceil((differenceInDays(e, s) + 1) / 7) + 1;
    for (let i = 0; i < nw; i++) {
      const ws = addWeeks(getMondayOfWeek(s), i);
      const weSunday = addDays(ws, 6);

      const newOverlapStart = s > ws ? s : ws;
      const newOverlapEnd = e < weSunday ? e : weSunday;
      if (newOverlapStart > newOverlapEnd) continue;

      // Hours this new booking adds in this week (mask-aware)
      let thisHours = 0;
      for (
        let d = new Date(newOverlapStart);
        d <= newOverlapEnd;
        d = addDays(d, 1)
      ) {
        if (!workingDaysMask[getISODay(d) - 1]) continue;
        if (weekdayMode) {
          thisHours += weekdayHours[String(d.getDay())] ?? 0;
        } else {
          thisHours += hoursPerDay;
        }
      }
      if (thisHours === 0) continue;

      // Hours already used by this employee's other bookings in this week (mask-aware)
      const used = empBookings.reduce((sum, b) => {
        const bs = parseISO(b.startDate);
        const be = parseISO(b.endDate);
        const bOverlapStart = bs > ws ? bs : ws;
        const bOverlapEnd = be < weSunday ? be : weSunday;
        if (bOverlapStart > bOverlapEnd) return sum;
        let bHours = 0;
        for (
          let d = new Date(bOverlapStart);
          d <= bOverlapEnd;
          d = addDays(d, 1)
        ) {
          if (!workingDaysMask[getISODay(d) - 1]) continue;
          if (b.weekdayHours != null) {
            bHours += b.weekdayHours[String(d.getDay())] ?? 0;
          } else {
            bHours += b.hoursPerDay;
          }
        }
        return sum + bHours;
      }, 0);

      // Capacity for the overlap = working days in overlap × daily capacity
      const workingDaysThisOverlap = countMaskDaysBetween(
        format(newOverlapStart, "yyyy-MM-dd"),
        format(newOverlapEnd, "yyyy-MM-dd"),
        workingDaysMask,
      );
      if (used + thisHours > workingDaysThisOverlap * dailyCapacity)
        return true;
    }
    return false;
  }, [
    startDate,
    endDate,
    hoursPerDay,
    weekdayMode,
    weekdayHours,
    allBookings,
    employeeId,
    capacity,
    workingDaysMask,
    isEdit,
    state,
  ]);
  // A role must be selected if the project has roles
  const rolesAvailable = projectRoles !== undefined;
  const hasRoles = rolesAvailable && projectRoles.length > 0;
  const roleRequired = !!projectId && hasRoles;

  const canSubmit =
    projectId &&
    (!roleRequired || roleId) &&
    startDate &&
    endDate &&
    startDate <= endDate &&
    (weekdayMode ? !allWeekdayZero : hoursPerDay > 0) &&
    !createMut.isPending &&
    !updateMut.isPending;

  async function handleSubmit() {
    if (!canSubmit) return;
    const payload = {
      employeeId,
      projectId: parseInt(projectId, 10),
      projectRoleId: roleId ? parseInt(roleId, 10) : null,
      startDate,
      endDate,
      ...(weekdayMode ? { weekdayHours } : { hoursPerDay, weekdayHours: null }),
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
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
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
                {projects
                  .filter((p) => p.active)
                  .map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span
                        className="truncate block max-w-[380px]"
                        title={`${p.name}${p.clientName ? ` (${p.clientName})` : ""}`}
                      >
                        {p.name}
                        {p.clientName ? ` (${p.clientName})` : ""}
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
                    {assignedRoles.length > 0 ? (
                      <>
                        <SelectGroup>
                          <SelectLabel className="text-xs text-muted-foreground px-2 py-1">
                            Assigned
                          </SelectLabel>
                          {assignedRoles.map((r) => {
                            const label =
                              r.name +
                              (r.dayRate > 0
                                ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                                : "");
                            return (
                              <SelectItem key={r.id} value={String(r.id)}>
                                <span
                                  className="truncate block max-w-[380px]"
                                  title={label + " (assigned)"}
                                >
                                  {label}{" "}
                                  <span className="text-muted-foreground text-xs">
                                    (assigned)
                                  </span>
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectGroup>
                        {unassignedRoles.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs text-muted-foreground px-2 py-1">
                                Other roles
                              </SelectLabel>
                              {unassignedRoles.map((r) => {
                                const label =
                                  r.name +
                                  (r.dayRate > 0
                                    ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                                    : "");
                                return (
                                  <SelectItem key={r.id} value={String(r.id)}>
                                    <span
                                      className="truncate block max-w-[380px]"
                                      title={label}
                                    >
                                      {label}
                                    </span>
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          </>
                        )}
                      </>
                    ) : (
                      projectRoles!.map((r) => {
                        const label =
                          r.name +
                          (r.dayRate > 0
                            ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                            : "");
                        return (
                          <SelectItem key={r.id} value={String(r.id)}>
                            <span
                              className="truncate block max-w-[380px]"
                              title={label}
                            >
                              {label}
                            </span>
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>End date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          {/* Hours per day / weekday mode */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Hours per day</Label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={weekdayMode}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setWeekdayHours({
                        "1": hoursPerDay,
                        "2": hoursPerDay,
                        "3": hoursPerDay,
                        "4": hoursPerDay,
                        "5": hoursPerDay,
                      });
                      setWeekdayMode(true);
                    } else {
                      // Exact average — no fallback; if 0, canSubmit stays false until user sets a value
                      const avg =
                        Object.values(weekdayHours).reduce((s, h) => s + h, 0) /
                        5;
                      setHoursPerDay(avg);
                      setHoursPerDayInput(String(avg));
                      setWeekdayMode(false);
                    }
                  }}
                />
                Set per weekday
              </label>
            </div>

            {!weekdayMode ? (
              <div className="flex gap-2">
                {[2, 4, 6, 8].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setHoursPerDay(preset);
                      setHoursPerDayInput(String(preset));
                    }}
                    className={`flex-1 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                      hoursPerDay === preset
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                    }`}
                  >
                    {preset}h
                  </button>
                ))}
                <Input
                  type="number"
                  min={0.5}
                  max={24}
                  step={0.5}
                  className="w-20 text-center"
                  value={hoursPerDayInput}
                  onChange={(e) => {
                    setHoursPerDayInput(e.target.value);
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v > 0) setHoursPerDay(v);
                  }}
                />
              </div>
            ) : (
              <div className="space-y-2">
                {/* Preset buttons */}
                <div className="flex gap-1.5 flex-wrap">
                  {WEEKDAY_PRESETS.map((p) => {
                    const active = matchesPreset(
                      weekdayHours,
                      p.hours as Record<string, number>,
                    );
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setWeekdayHours({ ...p.hours })}
                        className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  {!WEEKDAY_PRESETS.some((p) =>
                    matchesPreset(
                      weekdayHours,
                      p.hours as Record<string, number>,
                    ),
                  ) && (
                    <span className="px-2.5 py-1 rounded-md border border-primary bg-primary/10 text-primary text-xs font-medium">
                      Custom
                    </span>
                  )}
                </div>

                {/* Per-weekday inputs */}
                <div className="grid grid-cols-5 gap-1.5">
                  {(["1", "2", "3", "4", "5"] as const).map((key) => (
                    <div key={key} className="space-y-0.5">
                      <Label className="text-xs text-center block text-muted-foreground">
                        {DAY_LABELS[key]}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={24}
                        step={0.5}
                        className="text-center px-1"
                        value={weekdayHours[key] ?? 0}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setWeekdayHours((prev) => ({
                            ...prev,
                            [key]: isNaN(v) ? 0 : Math.max(0, Math.min(24, v)),
                          }));
                        }}
                      />
                    </div>
                  ))}
                </div>

                {/* All-zero warning */}
                {allWeekdayZero && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    All days are set to 0h — booking has no hours.
                  </div>
                )}
              </div>
            )}
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
              <div className="font-medium text-foreground mb-1">
                Booking summary
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Working days in period</span>
                <span className="font-medium text-foreground">
                  {bookingSummary.workingDays}d
                </span>
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
                <span className="text-foreground">
                  {bookingSummary.bookableDays}d
                </span>
              </div>
              {totalHours != null && totalHours > 0 && (
                <div className="border-t border-border/60 pt-1 font-medium text-foreground text-xs">
                  {weekdayMode && weeklyTotal != null ? (
                    <>
                      {formatWeekdayHours(weekdayHours)} (
                      {weeklyTotal % 1 === 0
                        ? weeklyTotal
                        : weeklyTotal.toFixed(1)}
                      h/week) →{" "}
                      {totalHours % 1 === 0
                        ? totalHours
                        : totalHours.toFixed(1)}
                      h total
                    </>
                  ) : (
                    <>
                      {bookingSummary.bookableDays}d ×{" "}
                      {hoursPerDay % 1 === 0
                        ? hoursPerDay
                        : hoursPerDay.toFixed(1)}
                      h ={" "}
                      {totalHours % 1 === 0
                        ? totalHours
                        : totalHours.toFixed(1)}
                      h total
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Role budget status box */}
          {roleId &&
            roleBudgetStatus &&
            (() => {
              const {
                budgetedDays,
                plannedDays,
                loggedDays,
                availableDays,
                employeeLoggedDays,
                bookings: roleBookings,
              } = roleBudgetStatus;
              const thisDays = thisBookingBudgetDays ?? 0;
              const r1 = (n: number) => Math.round(n * 10) / 10;

              if (budgetedDays == null) {
                return (
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex items-start gap-2">
                    <span className="mt-0.5">ℹ</span>
                    <span>No budget defined for this role.</span>
                  </div>
                );
              }

              const empBooking = roleBookings.find(
                (b) => b.employeeId === employeeId,
              );
              const empPlannedDays = r1(empBooking?.days ?? 0);
              const empLoggedDays = r1(employeeLoggedDays ?? 0);
              const empAvailable = r1(
                budgetedDays - empPlannedDays - empLoggedDays,
              );

              const roleAvailable = availableDays ?? 0;
              const empRemainingAfter = r1(empAvailable - thisDays);
              const roleRemainingAfter = r1(roleAvailable - thisDays);

              const statusColor = (val: number) => {
                if (val > 10) return "text-green-700 dark:text-green-400";
                if (val >= 0) return "text-yellow-700 dark:text-yellow-400";
                return "text-destructive";
              };
              const borderSeverity = (val: number) => {
                if (val > 10) return 0;
                if (val >= 0) return 1;
                return 2;
              };
              const worstSeverity = Math.max(
                borderSeverity(empRemainingAfter),
                borderSeverity(roleRemainingAfter),
              );
              const outerBorder =
                worstSeverity === 2
                  ? "border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/20"
                  : worstSeverity === 1
                    ? "border-yellow-400 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-950/20"
                    : "border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-950/20";

              const selectedRole = projectRoles?.find(
                (r) => String(r.id) === roleId,
              );
              const empName = isEdit
                ? (employees.find((e) => e.id === employeeId)?.name ??
                  "Employee")
                : (state as ModalState).employeeName;

              return (
                <div
                  className={`rounded-md border px-3 py-2.5 text-sm space-y-2 ${outerBorder}`}
                >
                  {/* Header */}
                  <div className="font-semibold text-foreground flex items-center gap-1.5">
                    <span>Role Budget</span>
                    {selectedRole && (
                      <span className="text-muted-foreground font-normal">
                        — {selectedRole.name}
                      </span>
                    )}
                  </div>

                  {/* Budgeted row (shared) */}
                  <div className="flex justify-between text-muted-foreground border-b border-border/40 pb-1.5">
                    <span>Budgeted</span>
                    <span className="font-medium text-foreground">
                      {budgetedDays}d
                    </span>
                  </div>

                  {/* THIS EMPLOYEE section */}
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                      👤 This employee: {empName}
                    </div>
                    <div className="flex justify-between text-muted-foreground pl-1">
                      <span>Already planned</span>
                      <span>−{empPlannedDays}d</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground pl-1">
                      <span>Already logged</span>
                      <span>−{empLoggedDays}d</span>
                    </div>
                    <div
                      className={`flex justify-between font-medium pl-1 ${statusColor(empAvailable)}`}
                    >
                      <span>Available</span>
                      <span>{empAvailable}d</span>
                    </div>
                  </div>

                  {/* ENTIRE ROLE section */}
                  <div className="space-y-0.5 border-t border-border/40 pt-1.5">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                      👥 Entire role: All {selectedRole?.name ?? ""}
                    </div>
                    {/* Per-employee breakdown */}
                    {roleBookings.length > 0 && (
                      <div className="pl-1 space-y-0.5 text-xs mb-1">
                        {roleBookings.map((rb) => (
                          <div
                            key={rb.employeeId}
                            className="flex justify-between text-muted-foreground/80"
                          >
                            <span className="truncate max-w-[140px]">
                              └ {rb.employeeName}
                            </span>
                            <span className="shrink-0 ml-2">
                              {rb.days}d planned · {rb.loggedDays}d logged
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex justify-between text-muted-foreground pl-1">
                      <span>Already planned</span>
                      <span>−{plannedDays}d</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground pl-1">
                      <span>Already logged</span>
                      <span>−{loggedDays}d</span>
                    </div>
                    <div
                      className={`flex justify-between font-medium pl-1 ${statusColor(roleAvailable)}`}
                    >
                      <span>Available</span>
                      <span>{availableDays ?? "—"}d</span>
                    </div>
                  </div>

                  {/* This booking + Remaining */}
                  {thisDays > 0 && (
                    <div className="border-t border-border/40 pt-1.5 space-y-0.5">
                      <div className="flex justify-between text-muted-foreground font-medium">
                        <span>📊 This booking</span>
                        <span>+{thisDays}d</span>
                      </div>
                      <div
                        className={`flex justify-between pl-1 ${statusColor(empRemainingAfter)}`}
                      >
                        <span>Remaining (individual)</span>
                        <span className="font-medium">
                          {empRemainingAfter}d
                        </span>
                      </div>
                      <div
                        className={`flex justify-between pl-1 ${statusColor(roleRemainingAfter)}`}
                      >
                        <span>Remaining (role)</span>
                        <span className="font-medium">
                          {roleRemainingAfter}d
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Red alert when role budget is exceeded */}
                  {roleRemainingAfter < 0 && (
                    <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-2.5 py-2 text-destructive text-xs">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        This booking will exceed the role budget by{" "}
                        {r1(Math.abs(roleRemainingAfter))}d. Consider: Reduce
                        scope OR assign more staff.
                      </span>
                    </div>
                  )}
                </div>
              );
            })()}

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
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete booking
            </Button>
          )}
          {isEdit && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Are you sure?
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
          {!confirmDelete && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
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

// ── Vacation Dialog ────────────────────────────────────────────────────────────
type VacationType = "vacation" | "sick" | "unpaid_leave" | "other";

const VACATION_TYPE_LABELS: Record<VacationType, string> = {
  vacation: "Vacation",
  sick: "Sick leave",
  unpaid_leave: "Unpaid leave",
  other: "Other absence",
};

interface VacationDialogCreateState {
  mode: "create";
  employeeId: number;
  employeeName: string;
  defaultStartDate?: string;
  defaultEndDate?: string;
}

interface VacationDialogEditState {
  mode: "edit";
  vacation: VacationEntry;
  employeeName: string;
}

type VacationDialogState = VacationDialogCreateState | VacationDialogEditState;

interface VacationDialogProps {
  state: VacationDialogState;
  onClose: () => void;
}

function VacationDialog({ state, onClose }: VacationDialogProps) {
  const { toast } = useToast();
  const createMut = useCreateVacation();
  const updateMut = useUpdateVacation();
  const deleteMut = useDeleteVacation();

  const isEdit = state.mode === "edit";
  const vacation = isEdit ? state.vacation : null;

  const [startDate, setStartDate] = useState(
    isEdit
      ? vacation!.startDate
      : ((state as VacationDialogCreateState).defaultStartDate ??
          format(new Date(), "yyyy-MM-dd")),
  );
  const [endDate, setEndDate] = useState(
    isEdit
      ? vacation!.endDate
      : ((state as VacationDialogCreateState).defaultEndDate ??
          format(new Date(), "yyyy-MM-dd")),
  );
  const [vacationType, setVacationType] = useState<VacationType>(
    isEdit ? (vacation!.vacationType as VacationType) : "vacation",
  );
  const [note, setNote] = useState(isEdit ? (vacation!.note ?? "") : "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const employeeId = isEdit
    ? vacation!.employeeId
    : (state as VacationDialogCreateState).employeeId;
  const employeeName = state.employeeName;

  const canSubmit = startDate && endDate && endDate >= startDate;

  async function handleSubmit() {
    const payload = {
      employeeId,
      startDate,
      endDate,
      vacationType,
      note: note.trim() || null,
    };
    try {
      if (isEdit) {
        await updateMut.mutateAsync({ id: vacation!.id, data: payload });
        toast({ title: "Absence updated" });
      } else {
        await createMut.mutateAsync(payload);
        toast({ title: "Absence created" });
      }
      onClose();
    } catch {
      toast({ title: "Error saving absence", variant: "destructive" });
    }
  }

  async function handleDelete() {
    try {
      await deleteMut.mutateAsync(vacation!.id);
      toast({ title: "Absence deleted" });
      onClose();
    } catch {
      toast({ title: "Error deleting absence", variant: "destructive" });
    }
  }

  const isSaving = createMut.isPending || updateMut.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit absence" : "Add absence"} — {employeeName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={vacationType}
              onValueChange={(v) => setVacationType(v as VacationType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(VACATION_TYPE_LABELS) as [
                    VacationType,
                    string,
                  ][]
                ).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vac-start">Start date</Label>
              <Input
                id="vac-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (e.target.value > endDate) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vac-end">End date</Label>
              <Input
                id="vac-end"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vac-note">
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Textarea
              id="vac-note"
              rows={2}
              placeholder="Optional note…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between pt-2">
          {isEdit && !confirmDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
          {isEdit && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Are you sure?
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
          {!confirmDelete && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit || isSaving}>
                {isSaving ? "Saving…" : isEdit ? "Save changes" : "Add absence"}
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
  const [vacationModal, setVacationModal] =
    useState<VacationDialogState | null>(null);
  const [filterClients, setFilterClients] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<number[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("alpha-asc");

  const dragStateRef = useRef<{
    bookingId: number;
    mode: "move" | "resize-start" | "resize-end";
    originX: number;
    originalStartDate: string;
    originalEndDate: string;
    dayWidth: number;
  } | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    bookingId: number;
    startDate: string;
    endDate: string;
  } | null>(null);

  const cellWidth = CELL_WIDTH[zoom];
  const numWeeks = NUM_WEEKS[zoom];

  const weeks = useMemo(
    () => Array.from({ length: numWeeks }, (_, i) => addWeeks(windowStart, i)),
    [windowStart, numWeeks],
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
    {
      query: { queryKey: getListEmployeesQueryKey({ includeInactive: false }) },
    },
  );
  const { data: projects = [] } = useListProjects(
    { includeInactive: false },
    {
      query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) },
    },
  );
  const { data: bookings = [], isLoading: bookingsLoading } =
    useResourceBookings();
  const { data: allVacations = [] } = useAllVacations();
  const { data: holidayCalendars = [] } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() },
  });

  const bookingsByEmployee = useMemo(() => {
    const map: Record<number, ResourceBookingFull[]> = {};
    for (const b of bookings) {
      (map[b.employeeId] ??= []).push(b);
    }
    return map;
  }, [bookings]);

  // ── Project budgets for booking bar tooltips ─────────────────────────────────
  const projectIdsWithRoles = useMemo(() => {
    const ids = new Set<number>();
    for (const b of bookings as ResourceBookingFull[]) {
      if (b.projectRoleId) ids.add(b.projectId);
    }
    return Array.from(ids);
  }, [bookings]);

  const plannerBudgetQueries = useQueries({
    queries: projectIdsWithRoles.map((pid) => ({
      queryKey: ["project-budget", String(pid)],
      queryFn: async () => {
        const r = await fetch(`/api/projects/${pid}/budget`, {
          credentials: "include",
        });
        if (!r.ok) return null;
        return r.json() as Promise<{
          roles: Array<{
            id: number;
            plannedDays: number;
            budgetedDays: number | null;
          }>;
        }>;
      },
    })),
  });

  // Map from roleId → {plannedDays, budgetedDays} for tooltip display
  const roleBudgetMap = useMemo(() => {
    const map = new Map<
      number,
      { plannedDays: number; budgetedDays: number | null }
    >();
    projectIdsWithRoles.forEach((pid, i) => {
      const data = plannerBudgetQueries[i]?.data;
      if (data?.roles) {
        for (const role of data.roles) {
          map.set(role.id, {
            plannedDays: role.plannedDays,
            budgetedDays: role.budgetedDays,
          });
        }
      }
    });
    return map;
  }, [projectIdsWithRoles, plannerBudgetQueries]);

  function openCreateModal(emp: (typeof employees)[number]) {
    const e = emp as any;
    setModal({
      mode: "create",
      employeeId: e.id,
      employeeName: e.name,
      capacity: e.weeklyCapacityHours ?? 40,
      workingDaysMask: Array.isArray(e.workingDaysMask)
        ? e.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: e.holidayCalendarCode ?? null,
    });
  }

  function openEditModal(b: ResourceBookingFull) {
    const emp = (employees as any[]).find((e) => e.id === b.employeeId);
    setModal({
      mode: "edit",
      booking: b,
      capacity: b.weeklyCapacityHours,
      workingDaysMask: Array.isArray(emp?.workingDaysMask)
        ? emp.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: emp?.holidayCalendarCode ?? null,
    });
  }

  const updateBookingMut = useUpdateBooking();
  const { toast } = useToast();

  function startBookingDrag(
    e: React.MouseEvent,
    booking: ResourceBookingFull,
    mode: "move" | "resize-start" | "resize-end",
    dayWidth: number,
  ) {
    e.stopPropagation();
    e.preventDefault();

    dragStateRef.current = {
      bookingId: booking.id,
      mode,
      originX: e.clientX,
      originalStartDate: booking.startDate,
      originalEndDate: booking.endDate,
      dayWidth,
    };

    function computeNewDates(
      ds: NonNullable<typeof dragStateRef.current>,
      deltaDays: number,
    ) {
      // Planner window boundaries (inclusive end = last visible day)
      const winStart = windowStart;
      const winEnd = addDays(windowStart, numWeeks * 7 - 1);

      let newStart = ds.originalStartDate;
      let newEnd = ds.originalEndDate;

      if (ds.mode === "move") {
        let rawStart = addDays(parseISO(ds.originalStartDate), deltaDays);
        let rawEnd = addDays(parseISO(ds.originalEndDate), deltaDays);
        // Soft-clamp to planner window, preserving booking duration
        if (rawStart < winStart) {
          const shift = differenceInDays(winStart, rawStart);
          rawStart = winStart;
          rawEnd = addDays(rawEnd, shift);
        }
        if (rawEnd > winEnd) {
          const shift = differenceInDays(rawEnd, winEnd);
          rawEnd = winEnd;
          rawStart = addDays(rawStart, -shift);
        }
        newStart = format(rawStart, "yyyy-MM-dd");
        newEnd = format(rawEnd, "yyyy-MM-dd");
      } else if (ds.mode === "resize-start") {
        // Minimum 1 day: start can equal end (inclusive dates, startDate === endDate is valid)
        let rawStart = addDays(parseISO(ds.originalStartDate), deltaDays);
        if (rawStart < winStart) rawStart = winStart;
        if (rawStart > parseISO(ds.originalEndDate))
          rawStart = parseISO(ds.originalEndDate);
        newStart = format(rawStart, "yyyy-MM-dd");
      } else {
        // Minimum 1 day: end can equal start (inclusive dates, startDate === endDate is valid)
        let rawEnd = addDays(parseISO(ds.originalEndDate), deltaDays);
        if (rawEnd > winEnd) rawEnd = winEnd;
        if (rawEnd < parseISO(ds.originalStartDate))
          rawEnd = parseISO(ds.originalStartDate);
        newEnd = format(rawEnd, "yyyy-MM-dd");
      }

      return { newStart, newEnd };
    }

    function onMouseMove(ev: MouseEvent) {
      const ds = dragStateRef.current;
      if (!ds) return;
      const delta = Math.round((ev.clientX - ds.originX) / ds.dayWidth);
      const { newStart, newEnd } = computeNewDates(ds, delta);
      setDragGhost({
        bookingId: ds.bookingId,
        startDate: newStart,
        endDate: newEnd,
      });
    }

    function onMouseUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      const ds = dragStateRef.current;
      dragStateRef.current = null;
      if (!ds) {
        setDragGhost(null);
        return;
      }
      const delta = Math.round((ev.clientX - ds.originX) / ds.dayWidth);
      if (delta === 0) {
        // Plain click — clear ghost and open edit modal
        setDragGhost(null);
        openEditModal(booking);
        return;
      }
      const { newStart, newEnd } = computeNewDates(ds, delta);
      // Keep ghost alive (optimistic UI) until mutation settles
      updateBookingMut.mutate(
        {
          id: ds.bookingId,
          data: {
            employeeId: booking.employeeId,
            projectId: booking.projectId,
            projectRoleId: booking.projectRoleId,
            startDate: newStart,
            endDate: newEnd,
            hoursPerDay: booking.hoursPerDay,
            weekdayHours: booking.weekdayHours,
            notes: booking.notes,
          },
        },
        {
          onSuccess: () => {
            // Query invalidation will load fresh server data; clear ghost now
            setDragGhost(null);
          },
          onError: () => {
            // Revert to server position
            setDragGhost(null);
            toast({ title: "Failed to move booking", variant: "destructive" });
          },
        },
      );
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function openCreateVacationModal(
    emp: any,
    defaultStartDate?: string,
    defaultEndDate?: string,
  ) {
    setVacationModal({
      mode: "create",
      employeeId: emp.id,
      employeeName: emp.name,
      defaultStartDate,
      defaultEndDate,
    });
  }

  function openEditVacationModal(v: VacationEntry, empName: string) {
    setVacationModal({
      mode: "edit",
      vacation: v,
      employeeName: empName,
    });
  }

  const contentWidth = numWeeks * cellWidth;

  const allActiveEmployees = useMemo(
    () => (employees as any[]).filter((e) => e.active !== false),
    [employees],
  );

  // ── Derived filter options ──────────────────────────────────────────────────
  const availableClients = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const b of bookings as ResourceBookingFull[]) {
      if (b.clientName && !seen.has(b.clientName)) {
        seen.add(b.clientName);
        list.push(b.clientName);
      }
    }
    return list.sort();
  }, [bookings]);

  const availableProjects = useMemo(() => {
    const seen = new Set<number>();
    const list: { id: number; name: string }[] = [];
    for (const b of bookings as ResourceBookingFull[]) {
      if (!seen.has(b.projectId)) {
        seen.add(b.projectId);
        list.push({ id: b.projectId, name: b.projectName });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [bookings]);

  const activeFilters = filterClients.length + filterProjects.length;

  // ── Filtered + sorted employees ─────────────────────────────────────────────
  const activeEmployees = useMemo(() => {
    let list = allActiveEmployees;
    if (activeFilters > 0) {
      list = list.filter((emp: any) => {
        const empBookings = (bookings as ResourceBookingFull[]).filter(
          (b) => b.employeeId === emp.id,
        );
        return empBookings.some((b) => {
          const clientOk =
            filterClients.length === 0 ||
            (b.clientName && filterClients.includes(b.clientName));
          const projectOk =
            filterProjects.length === 0 || filterProjects.includes(b.projectId);
          return clientOk && projectOk;
        });
      });
    }
    return [...list].sort((a: any, b: any) => {
      if (sortMode === "alpha-asc") return a.name.localeCompare(b.name);
      if (sortMode === "alpha-desc") return b.name.localeCompare(a.name);
      const aTotal = (bookings as ResourceBookingFull[])
        .filter((bk) => bk.employeeId === a.id)
        .reduce((s, bk) => s + bk.hoursPerDay, 0);
      const bTotal = (bookings as ResourceBookingFull[])
        .filter((bk) => bk.employeeId === b.id)
        .reduce((s, bk) => s + bk.hoursPerDay, 0);
      return sortMode === "alloc-desc" ? bTotal - aTotal : aTotal - bTotal;
    });
  }, [
    allActiveEmployees,
    bookings,
    filterClients,
    filterProjects,
    activeFilters,
    sortMode,
  ]);

  // ── Vacation markers ──────────────────────────────────────────────────────
  const vacationsByEmployee = useMemo(() => {
    const map: Record<number, VacationEntry[]> = {};
    for (const v of allVacations) {
      (map[v.employeeId] ??= []).push(v);
    }
    return map;
  }, [allVacations]);

  // ── Holiday markers ───────────────────────────────────────────────────────
  const calendarIdByCode = useMemo(() => {
    const map: Record<string, number> = {};
    for (const cal of holidayCalendars as any[]) {
      map[cal.code] = cal.id;
    }
    return map;
  }, [holidayCalendars]);

  const visibleYears = useMemo(() => {
    const years = new Set<number>();
    years.add(windowStart.getFullYear());
    years.add(windowEnd.getFullYear());
    return [...years];
  }, [windowStart, windowEnd]);

  const uniqueCalendarQueries = useMemo(() => {
    const seen = new Set<string>();
    const queries: Array<{ calendarId: number; year: number; code: string }> =
      [];
    for (const emp of activeEmployees) {
      const code: string | null = (emp as any).holidayCalendarCode ?? null;
      if (!code) continue;
      const calendarId = calendarIdByCode[code];
      if (!calendarId) continue;
      for (const year of visibleYears) {
        const key = `${calendarId}-${year}`;
        if (!seen.has(key)) {
          seen.add(key);
          queries.push({ calendarId, year, code });
        }
      }
    }
    return queries;
  }, [activeEmployees, calendarIdByCode, visibleYears]);

  const holidayQueryResults = useQueries({
    queries: uniqueCalendarQueries.map(({ calendarId, year }) => ({
      queryKey: ["planner-holidays", calendarId, year],
      queryFn: async (): Promise<HolidayEntry[]> => {
        const r = await fetch(
          `/api/holiday-calendars/${calendarId}/holidays?year=${year}`,
          { credentials: "include" },
        );
        if (!r.ok) throw new Error("Failed to fetch holidays");
        return r.json();
      },
      enabled: true,
    })),
  });

  const holidaysByCalendarId = useMemo(() => {
    const map: Record<number, HolidayEntry[]> = {};
    holidayQueryResults.forEach((result, idx) => {
      if (!result.data) return;
      const { calendarId } = uniqueCalendarQueries[idx];
      (map[calendarId] ??= []).push(...result.data);
    });
    return map;
  }, [holidayQueryResults, uniqueCalendarQueries]);

  const holidaysByEmployee = useMemo(() => {
    const map: Record<number, HolidayEntry[]> = {};
    for (const emp of activeEmployees) {
      const code: string | null = (emp as any).holidayCalendarCode ?? null;
      if (!code) continue;
      const calendarId = calendarIdByCode[code];
      if (!calendarId) continue;
      const holidays = holidaysByCalendarId[calendarId] ?? [];
      const windowStartStr = format(windowStart, "yyyy-MM-dd");
      const windowEndStr = format(windowEnd, "yyyy-MM-dd");
      map[(emp as any).id] = holidays.filter(
        (h) => h.date >= windowStartStr && h.date < windowEndStr,
      );
    }
    return map;
  }, [
    activeEmployees,
    calendarIdByCode,
    holidaysByCalendarId,
    windowStart,
    windowEnd,
  ]);

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
            <h1 className="text-xl font-bold tracking-tight">
              Resource Planner
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setWindowStart((prev) => addWeeks(prev, -NAV_WEEKS[zoom]))
              }
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <span className="text-sm font-medium w-40 text-center">
              {windowLabel}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setWindowStart((prev) => addWeeks(prev, NAV_WEEKS[zoom]))
              }
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

          <div className="flex items-center gap-2 flex-wrap">
            {/* Client filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Filter className="h-3.5 w-3.5" />
                  Client
                  {filterClients.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 leading-none">
                      {filterClients.length}
                    </span>
                  )}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-[180px] max-h-72 overflow-y-auto"
              >
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Filter by client
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableClients.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No clients with bookings
                  </div>
                ) : (
                  availableClients.map((client) => {
                    const selected = filterClients.includes(client);
                    return (
                      <DropdownMenuItem
                        key={client}
                        onSelect={(e) => {
                          e.preventDefault();
                          setFilterClients((prev) =>
                            selected
                              ? prev.filter((c) => c !== client)
                              : [...prev, client],
                          );
                        }}
                        className="gap-2 cursor-pointer"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${selected ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}
                        >
                          {selected && <Check className="h-3 w-3" />}
                        </span>
                        <span className="truncate">{client}</span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Project filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Filter className="h-3.5 w-3.5" />
                  Project
                  {filterProjects.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 leading-none">
                      {filterProjects.length}
                    </span>
                  )}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-[200px] max-h-72 overflow-y-auto"
              >
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Filter by project
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableProjects.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No projects with bookings
                  </div>
                ) : (
                  availableProjects.map((proj) => {
                    const selected = filterProjects.includes(proj.id);
                    return (
                      <DropdownMenuItem
                        key={proj.id}
                        onSelect={(e) => {
                          e.preventDefault();
                          setFilterProjects((prev) =>
                            selected
                              ? prev.filter((p) => p !== proj.id)
                              : [...prev, proj.id],
                          );
                        }}
                        className="gap-2 cursor-pointer"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${selected ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}
                        >
                          {selected && <Check className="h-3 w-3" />}
                        </span>
                        <span className="truncate">{proj.name}</span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Active filters badge + clear */}
            {activeFilters > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setFilterClients([]);
                  setFilterProjects([]);
                }}
              >
                Filters ({activeFilters})
                <X className="h-3.5 w-3.5" />
              </Button>
            )}

            {/* Sort */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  {sortMode === "alpha-asc"
                    ? "A–Z"
                    : sortMode === "alpha-desc"
                      ? "Z–A"
                      : sortMode === "alloc-desc"
                        ? "Most allocated"
                        : "Least allocated"}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Sort employees
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(
                  [
                    { value: "alpha-asc", label: "A–Z" },
                    { value: "alpha-desc", label: "Z–A" },
                    { value: "alloc-desc", label: "Most allocated" },
                    { value: "alloc-asc", label: "Least allocated" },
                  ] as { value: SortMode; label: string }[]
                ).map(({ value, label }) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => setSortMode(value)}
                    className="gap-2 cursor-pointer"
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center`}
                    >
                      {sortMode === value && <Check className="h-3 w-3" />}
                    </span>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Zoom toggle */}
          <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
            {(["month", "quarter", "year"] as ZoomLevel[]).map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`px-3 py-1 text-xs rounded font-medium capitalize transition-colors ${
                  zoom === z
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {z === "month" ? "Month" : z === "quarter" ? "Quarter" : "Year"}
              </button>
            ))}
          </div>
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
              const visibleBookings = empBookings.filter(
                (b) =>
                  getBarBounds(
                    b.startDate,
                    b.endDate,
                    windowStart,
                    numWeeks,
                    cellWidth,
                  ) !== null,
              );
              const laned = assignLanes(visibleBookings);
              const laneCount =
                laned.length > 0
                  ? Math.max(...laned.map((b) => b.lane)) + 1
                  : 0;
              const barH = laneCount > 1 ? BAR_H_STACKED : BAR_H_SINGLE;
              const rowHeight = calcRowHeight(laneCount);
              const hiddenCount = laned.filter(
                (b) => b.lane >= MAX_VISIBLE_LANES,
              ).length;

              return (
                <div
                  key={emp.id}
                  className="flex border-b border-border group"
                  style={{ minHeight: rowHeight }}
                >
                  {/* Employee info — sticky left */}
                  <div
                    className="sticky left-0 z-10 bg-card border-r border-border shrink-0 flex items-center gap-1 px-3"
                    style={{ width: EMPLOYEE_COL, height: rowHeight }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-sm font-medium truncate flex-1 min-w-0 cursor-default">
                          {emp.name}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs">
                        {cap}h/week capacity
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 rounded p-0.5 hover:bg-muted"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        side="bottom"
                        className="min-w-[120px]"
                      >
                        <DropdownMenuItem onSelect={() => openCreateModal(emp)}>
                          Booking
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => openCreateVacationModal(emp)}
                        >
                          Absence
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Timeline area */}
                  <div
                    className="relative flex-1"
                    style={{ width: contentWidth, minHeight: rowHeight }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const offsetX = e.clientX - rect.left;
                      const dayWidth = cellWidth / 7;
                      const dayOffset = Math.floor(offsetX / dayWidth);
                      const clampedOffset = Math.max(
                        0,
                        Math.min(dayOffset, numWeeks * 7 - 1),
                      );
                      const clickedDate = format(
                        addDays(windowStart, clampedOffset),
                        "yyyy-MM-dd",
                      );
                      openCreateVacationModal(emp, clickedDate, clickedDate);
                    }}
                  >
                    {/* Capacity cells */}
                    <div className="flex h-full absolute inset-0">
                      {weeks.map((_w, i) => (
                        <div
                          key={i}
                          className="shrink-0 border-r border-border/30 last:border-r-0"
                          style={{ width: cellWidth, height: "100%" }}
                        />
                      ))}
                    </div>

                    {/* Vacation bands */}
                    {(vacationsByEmployee[emp.id] ?? []).map((v) => {
                      const bounds = getBarBounds(
                        v.startDate,
                        v.endDate,
                        windowStart,
                        numWeeks,
                        cellWidth,
                      );
                      if (!bounds) return null;
                      return (
                        <Tooltip key={`vac-${v.id}`}>
                          <TooltipTrigger asChild>
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label={`Edit ${v.vacationType.replace(/_/g, " ")} for ${emp.name}`}
                              className="absolute pointer-events-auto cursor-pointer hover:brightness-90 transition-all focus:outline-none focus:ring-2 focus:ring-orange-400"
                              style={{
                                top: 0,
                                bottom: 0,
                                left: bounds.left,
                                width: bounds.width,
                                background:
                                  "repeating-linear-gradient(-45deg, transparent, transparent 4px, rgba(251,146,60,0.22) 4px, rgba(251,146,60,0.22) 8px)",
                                zIndex: 2,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditVacationModal(v, emp.name);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ")
                                  openEditVacationModal(v, emp.name);
                              }}
                            />
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="text-xs space-y-0.5"
                          >
                            <div className="font-semibold capitalize">
                              {v.vacationType.replace(/_/g, " ")}
                            </div>
                            <div>
                              {format(parseISO(v.startDate), "MMM d")} –{" "}
                              {format(parseISO(v.endDate), "MMM d, yyyy")}
                            </div>
                            {v.note && (
                              <div className="text-muted-foreground italic">
                                {v.note}
                              </div>
                            )}
                            <div className="text-muted-foreground text-[10px] pt-0.5">
                              Click to edit
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}

                    {/* Holiday markers */}
                    {(holidaysByEmployee[emp.id] ?? []).map((h) => {
                      const dayWidth = cellWidth / 7;
                      const hDate = parseISO(h.date);
                      const offset = differenceInDays(hDate, windowStart);
                      if (offset < 0 || offset >= numWeeks * 7) return null;
                      const left = offset * dayWidth;
                      return (
                        <Tooltip key={`hol-${h.id}`}>
                          <TooltipTrigger asChild>
                            <div
                              className="absolute pointer-events-auto"
                              style={{
                                top: 0,
                                bottom: 0,
                                left,
                                width: Math.max(dayWidth, 2),
                                backgroundColor: "rgba(147,197,253,0.35)",
                                zIndex: 2,
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="text-xs space-y-0.5"
                          >
                            <div className="font-semibold">{h.name}</div>
                            <div>{format(hDate, "MMM d, yyyy")}</div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}

                    {/* Booking bars — stacked by lane */}
                    {laned.map((b) => {
                      if (b.lane >= MAX_VISIBLE_LANES) return null;
                      const ghost =
                        dragGhost?.bookingId === b.id ? dragGhost : null;
                      const bounds = getBarBounds(
                        ghost ? ghost.startDate : b.startDate,
                        ghost ? ghost.endDate : b.endDate,
                        windowStart,
                        numWeeks,
                        cellWidth,
                      );
                      if (!bounds) return null;
                      const color = resolveProjectColor(
                        b.projectId,
                        b.projectColor,
                      );
                      const barTop = BAR_PAD_TOP + b.lane * (barH + BAR_GAP);
                      const hpd =
                        b.hoursPerDay % 1 === 0
                          ? String(b.hoursPerDay)
                          : b.hoursPerDay.toFixed(1);
                      const label = [
                        b.clientName
                          ? `${b.clientName} – ${b.projectName}`
                          : b.projectName,
                        b.projectRoleName,
                        `${hpd}h/d`,
                      ]
                        .filter(Boolean)
                        .join(" | ");
                      const charBudget = Math.max(
                        1,
                        Math.floor(bounds.width / 7) - 1,
                      );
                      const isDragging = ghost !== null;
                      const bDayWidth = cellWidth / 7;

                      const barDiv = (
                        <div
                          className={`absolute rounded-sm flex items-center px-2 overflow-hidden shadow-sm${isDragging ? "" : " hover:brightness-90 transition-all"}`}
                          style={{
                            top: barTop,
                            height: barH,
                            left: bounds.left,
                            width: bounds.width,
                            backgroundColor: color,
                            borderLeft: `3px solid ${darkenColor(color)}`,
                            opacity: isDragging ? 0.75 : 0.9,
                            cursor: isDragging ? "grabbing" : "grab",
                            zIndex: isDragging ? 5 : 4,
                            userSelect: "none",
                          }}
                          onMouseDown={(e) =>
                            startBookingDrag(e, b, "move", bDayWidth)
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Left resize handle */}
                          <div
                            className="absolute top-0 left-0 h-full"
                            style={{ width: 7, cursor: "ew-resize", zIndex: 1 }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              startBookingDrag(e, b, "resize-start", bDayWidth);
                            }}
                          />
                          {bounds.width > 16 && (
                            <div className="text-white text-[10px] font-semibold leading-none truncate select-none">
                              {isDragging
                                ? `${format(parseISO(ghost!.startDate), "MMM d")} – ${format(parseISO(ghost!.endDate), "MMM d")}`
                                : label.length <= charBudget
                                  ? label
                                  : label.slice(0, charBudget) + "…"}
                            </div>
                          )}
                          {/* Right resize handle */}
                          <div
                            className="absolute top-0 right-0 h-full"
                            style={{ width: 7, cursor: "ew-resize", zIndex: 1 }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              startBookingDrag(e, b, "resize-end", bDayWidth);
                            }}
                          />
                        </div>
                      );

                      if (isDragging) {
                        return (
                          <div key={b.id} style={{ display: "contents" }}>
                            {barDiv}
                          </div>
                        );
                      }

                      return (
                        <Tooltip key={b.id}>
                          <TooltipTrigger asChild>{barDiv}</TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="text-xs max-w-[240px] p-0"
                          >
                            {/* Header: project + client */}
                            <div className="px-3 pt-2.5 pb-1.5">
                              <div className="font-semibold text-gray-900">
                                {b.projectName}
                              </div>
                              {b.clientName && (
                                <div className="text-gray-500">
                                  {b.clientName}
                                </div>
                              )}
                            </div>

                            {/* Details: role, allocation, dates, total */}
                            <div className="px-3 pb-2 space-y-0.5 border-t border-gray-200 pt-1.5">
                              {b.projectRoleName && (
                                <div className="text-primary font-medium">
                                  {b.projectRoleName}
                                  {b.dayRate
                                    ? ` — €${b.dayRate.toLocaleString("de-DE")}/day`
                                    : ""}
                                </div>
                              )}
                              <div className="text-gray-700">{hpd}h/day</div>
                              <div className="text-gray-700">
                                {format(parseISO(b.startDate), "MMM d")} –{" "}
                                {format(parseISO(b.endDate), "MMM d, yyyy")}
                              </div>
                              <div className="text-gray-700">
                                Total:{" "}
                                {(
                                  countWeekdaysBetween(b.startDate, b.endDate) *
                                  b.hoursPerDay
                                ).toFixed(0)}
                                h
                              </div>
                              {b.notes && (
                                <div className="text-gray-500 italic">
                                  {b.notes}
                                </div>
                              )}
                            </div>

                            {/* Budget strip — full width, colored background */}
                            {b.projectRoleId &&
                              (() => {
                                const rb = roleBudgetMap.get(b.projectRoleId);
                                if (!rb || rb.budgetedDays == null) return null;
                                const isOver = rb.plannedDays > rb.budgetedDays;
                                return (
                                  <div
                                    className={`px-3 py-1.5 border-t border-gray-200 ${
                                      isOver
                                        ? "bg-red-50 text-red-600 font-semibold"
                                        : "bg-green-50 text-green-700"
                                    }`}
                                  >
                                    {isOver ? "⚠ Over budget: " : "✓ Budget: "}
                                    {rb.plannedDays.toFixed(1)} /{" "}
                                    {rb.budgetedDays}d planned
                                  </div>
                                );
                              })()}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}

                    {/* "+N more" indicator for overflowing lanes */}
                    {hiddenCount > 0 && (
                      <div
                        className="absolute text-[10px] text-muted-foreground select-none pointer-events-none px-1"
                        style={{
                          top:
                            BAR_PAD_TOP +
                            MAX_VISIBLE_LANES * (BAR_H_STACKED + BAR_GAP),
                          left: 4,
                          zIndex: 4,
                        }}
                      >
                        +{hiddenCount} more
                      </div>
                    )}

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

        {/* Vacation dialog */}
        {vacationModal && (
          <VacationDialog
            state={vacationModal}
            onClose={() => setVacationModal(null)}
          />
        )}
      </div>
    </AdminLayout>
  );
}
