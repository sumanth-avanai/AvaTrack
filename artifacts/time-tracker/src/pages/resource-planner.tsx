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
  Clock,
  Undo2,
  Info,
  Sun,
  Star,
  Thermometer,
  Minus,
  Search,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { resolveProjectColor, PROJECT_COLORS } from "@workspace/api-zod";

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
  pastReleasedAt: string | null;
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

// ── Day-level segment types ───────────────────────────────────────────────────
interface SegmentBase {
  bookingId: number;
  startOffset: number; // days from windowStart, 0-indexed inclusive
  endOffset: number;   // days from windowStart, inclusive
  roleName: string | null;
  color: string;
  projectName: string;
  clientName: string | null;
  dayRate: number | null;
  bookingStartDate: string;
  bookingEndDate: string;
  notes: string | null;
  pastReleasedAt: string | null;
  projectRoleId: number | null;
  projectId: number;
  dailyHours: number[]; // one entry per day in [startOffset, endOffset]
}
type Segment = SegmentBase & { lane: number };

/** Hours this booking contributes to a given calendar day (0 if outside range,
 *  off the employee's working-day mask in flat mode, or on a holiday/vacation). */
function getHoursForDayBooking(
  booking: ResourceBookingFull,
  day: Date,
  empMask: number[],
  holidayDateSet: Set<string>,
  vacationDateSet: Set<string>,
): number {
  const dayStr = format(day, "yyyy-MM-dd");
  if (dayStr < booking.startDate || dayStr > booking.endDate) return 0;
  if (holidayDateSet.has(dayStr) || vacationDateSet.has(dayStr)) return 0;
  if (booking.weekdayHours != null) {
    // weekdayHours keys are "1"=Mon … "5"=Fri, matching getDay() for Mon–Fri
    return booking.weekdayHours[String(day.getDay())] ?? 0;
  }
  // Flat mode: apply only on the employee's working-mask days
  const isoIdx = getISODay(day) - 1; // 0=Mon … 6=Sun
  if (!empMask[isoIdx]) return 0;
  return booking.hoursPerDay;
}

/** Daily capacity in hours for one working day. */
function getDailyCapacity(weeklyCapacityHours: number, mask: number[]): number {
  const activeDays = mask.reduce((s, v) => s + v, 0);
  return activeDays > 0 ? weeklyCapacityHours / activeDays : 0;
}

/** Build segments (consecutive non-zero days) for one booking over the visible window. */
function buildBookingSegments(
  booking: ResourceBookingFull,
  windowStartDate: Date,
  numWeeks: number,
  color: string,
  empMask: number[],
  holidayDateSet: Set<string>,
  vacationDateSet: Set<string>,
): SegmentBase[] {
  const segments: SegmentBase[] = [];
  const totalDays = numWeeks * 7;
  let curStart: number | null = null;
  let dailyHours: number[] = [];

  const base: Omit<SegmentBase, "startOffset" | "endOffset" | "dailyHours"> = {
    bookingId: booking.id,
    roleName: booking.projectRoleName,
    color,
    projectName: booking.projectName,
    clientName: booking.clientName,
    dayRate: booking.dayRate,
    bookingStartDate: booking.startDate,
    bookingEndDate: booking.endDate,
    notes: booking.notes,
    pastReleasedAt: booking.pastReleasedAt,
    projectRoleId: booking.projectRoleId,
    projectId: booking.projectId,
  };

  for (let offset = 0; offset < totalDays; offset++) {
    const day = addDays(windowStartDate, offset);
    const hours = getHoursForDayBooking(
      booking,
      day,
      empMask,
      holidayDateSet,
      vacationDateSet,
    );
    if (hours > 0) {
      if (curStart === null) curStart = offset;
      dailyHours.push(hours);
    } else {
      if (curStart !== null) {
        segments.push({ ...base, startOffset: curStart, endOffset: offset - 1, dailyHours });
        curStart = null;
        dailyHours = [];
      }
    }
  }
  if (curStart !== null) {
    segments.push({ ...base, startOffset: curStart, endOffset: totalDays - 1, dailyHours });
  }
  return segments;
}

/** Assign lanes to segments using greedy interval scheduling. */
function assignSegmentLanes(segments: SegmentBase[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.startOffset - b.startOffset);
  const laneEnds: number[] = [];
  return sorted.map((seg) => {
    let lane = laneEnds.findIndex((end) => seg.startOffset > end);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = seg.endOffset;
    return { ...seg, lane };
  });
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

function useReleasePastBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}/release-past`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to release past plan");
      return res.json() as Promise<ResourceBookingFull>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useUnreleaseBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}/unrelease`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to undo release");
      return res.json() as Promise<ResourceBookingFull>;
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
  openInConfirmRelease?: boolean;
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
  onBookingUpdated?: (booking: ResourceBookingFull) => void;
  initialConfirmRelease?: boolean;
}

function BookingModal({
  state,
  projects,
  allBookings,
  employees,
  onClose,
  onBookingUpdated,
  initialConfirmRelease,
}: BookingModalProps) {
  const { toast } = useToast();
  const createMut = useCreateBooking();
  const updateMut = useUpdateBooking();
  const deleteMut = useDeleteBooking();
  const releaseMut = useReleasePastBooking();
  const unreleaseMut = useUnreleaseBooking();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(initialConfirmRelease ?? false);

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
    invoicedDays: number;
  }
  interface RoleBudgetStatus {
    budgetedDays: number | null;
    plannedDays: number;
    loggedDays: number;
    invoicedDays: number;
    reservedDays: number;
    unplannedDays: number | null;
    freeDays: number | null;
    remainingBudgetDays: number | null;
    loggedNotInvoicedDays: number;
    employeeLoggedDays: number | null;
    employeeInvoicedDays: number | null;
    bookings: RoleBudgetBooking[];
  }
  // Role budget is fetched LIVE — the slot being edited is NOT excluded, so
  // these figures match the Budget / Allocations tabs exactly. The marginal
  // effect of unsaved edits is shown separately as a "projected" line below.
  const { data: roleBudgetStatus } = useQuery<RoleBudgetStatus>({
    queryKey: ["role-budget-status", roleId, employeeId],
    queryFn: async () => {
      const params = new URLSearchParams();
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
  // Total hours
  const totalHours =
    calcResult && calcResult.totalHours > 0 ? calcResult.totalHours : null;

  // Past undelivered days (for release button): fetched server-side so that
  // logged hours are subtracted per booking, not role-wide. Disabled when
  // already released or no booking id.
  const editBookingId = isEdit ? (state as EditModalState).booking.id : null;
  const editBookingReleased = isEdit ? !!(state as EditModalState).booking.pastReleasedAt : false;
  const { data: pastUndeliveredData } = useQuery<{ pastUndeliveredDays: number }>({
    queryKey: ["booking-past-undelivered", editBookingId],
    queryFn: async () => {
      const res = await fetch(`/api/resource-bookings/${editBookingId}/past-undelivered`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch past undelivered days");
      return res.json();
    },
    enabled: isEdit && !!editBookingId && !editBookingReleased,
    staleTime: 30_000,
  });
  const pastPlanDays = editBookingReleased ? 0 : (pastUndeliveredData?.pastUndeliveredDays ?? 0);

  // Days this slot actually books against the role budget — RELEASE-AWARE and
  // computed inline (not via a memo) so it always tracks the latest edits and
  // matches the projected delta below. A released booking only books its
  // future (today-onward) portion, since its past undelivered plan is freed.
  const slotTodayStr = new Date().toISOString().slice(0, 10);
  const booksAgainstBudget = (() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    const wh = weekdayMode ? weekdayHours : null;
    const calc = (from: string) =>
      calcBookingHoursClient(
        from, endDate, hoursPerDay, wh,
        workingDaysMask, holidayDates, vacations,
      ).budgetDays;
    if (!editBookingReleased) return calc(startDate);
    if (endDate < slotTodayStr) return 0;
    return calc(startDate >= slotTodayStr ? startDate : slotTodayStr);
  })();

  // Weekday-mode derived values
  // Only count days the employee actually works — hours entered on a
  // non-working weekday are ignored by the (mask-based) budget math.
  const weeklyTotal = weekdayMode
    ? (["1", "2", "3", "4", "5"] as const).reduce(
        (s, k) => s + (workingDaysMask[Number(k) - 1] ? (weekdayHours[k] ?? 0) : 0),
        0,
      )
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
      ...(weekdayMode
        ? {
            // Persist hours only for actual working days; non-working weekdays
            // are ignored by the budget math, so never store stale values.
            weekdayHours: Object.fromEntries(
              (["1", "2", "3", "4", "5"] as const)
                .filter((k) => workingDaysMask[Number(k) - 1])
                .map((k) => [k, weekdayHours[k] ?? 0]),
            ) as Record<string, number>,
          }
        : { hoursPerDay, weekdayHours: null }),
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
                  {(["1", "2", "3", "4", "5"] as const).map((key) => {
                    const isWorkingDay = !!workingDaysMask[Number(key) - 1];
                    return (
                      <div key={key} className="space-y-0.5">
                        <Label
                          className={`text-xs text-center block ${isWorkingDay ? "text-muted-foreground" : "text-muted-foreground/40"}`}
                        >
                          {DAY_LABELS[key]}
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          disabled={!isWorkingDay}
                          title={
                            isWorkingDay
                              ? undefined
                              : "Not a working day for this employee — hours here are not counted."
                          }
                          className={`text-center px-1 ${!isWorkingDay ? "opacity-40 cursor-not-allowed" : ""}`}
                          value={isWorkingDay ? (weekdayHours[key] ?? 0) : 0}
                          onChange={(e) => {
                            if (!isWorkingDay) return;
                            const v = parseFloat(e.target.value);
                            setWeekdayHours((prev) => ({
                              ...prev,
                              [key]: isNaN(v) ? 0 : Math.max(0, Math.min(24, v)),
                            }));
                          }}
                        />
                      </div>
                    );
                  })}
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
              <div className="font-medium text-foreground mb-1 flex items-center gap-1.5">
                <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
                This slot
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
              {booksAgainstBudget != null && (
                <div className="flex justify-between text-muted-foreground">
                  <span>
                    Books against role budget
                    {editBookingReleased ? (
                      <span className="text-xs text-muted-foreground/70"> (future only)</span>
                    ) : null}
                  </span>
                  <span className="font-medium text-blue-600 dark:text-blue-400">
                    +{Math.round(booksAgainstBudget * 10) / 10}d
                  </span>
                </div>
              )}
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

          {/* ── This slot: past vs. future, anchored to today + release ───────── */}
          {isEdit && (() => {
            const todayStr = new Date().toISOString().slice(0, 10);
            const todayLabel = format(new Date(), "MMM d, yyyy");
            const released = !!(state as EditModalState).booking.pastReleasedAt;
            const bStart = (state as EditModalState).booking.startDate;
            const bEnd = (state as EditModalState).booking.endDate;
            const hasPast = bStart < todayStr;
            const hasFuture = bEnd >= todayStr;
            return (
              <div className="rounded-md border border-border bg-card px-3 py-2.5 text-sm space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-foreground flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    This slot · past vs. future
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    as of today, {todayLabel}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Today is the dividing line. Planned days{" "}
                  <span className="font-medium text-foreground">before today</span> that were
                  never logged are <span className="font-medium text-foreground">undelivered</span>{" "}
                  and silently hold budget. Releasing them frees that reservation —{" "}
                  <span className="font-medium text-foreground">future plan and logged work are always kept.</span>
                </p>
                {released ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 border border-border px-2.5 py-2">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" /> Past undelivered plan released
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-7"
                      disabled={unreleaseMut.isPending}
                      onClick={async () => {
                        try {
                          await unreleaseMut.mutateAsync((state as EditModalState).booking.id);
                          toast({ title: "Release undone" });
                          onClose();
                        } catch {
                          toast({ title: "Failed to undo release", variant: "destructive" });
                        }
                      }}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      {unreleaseMut.isPending ? "Undoing…" : "Undo release"}
                    </Button>
                  </div>
                ) : pastPlanDays > 0 ? (
                  confirmRelease ? (
                    <div className="flex items-center gap-2 flex-wrap rounded-md bg-muted/60 border border-border px-2.5 py-2">
                      <span className="text-xs text-muted-foreground">
                        Release {Math.round(pastPlanDays * 10) / 10}d of past undelivered plan? Future plan &amp; logged work are kept.
                      </span>
                      <Button
                        size="sm"
                        className="h-7"
                        disabled={releaseMut.isPending}
                        onClick={async () => {
                          try {
                            const updated = await releaseMut.mutateAsync((state as EditModalState).booking.id);
                            toast({ title: "Past plan released" });
                            if (onBookingUpdated) {
                              setConfirmRelease(false);
                              onBookingUpdated(updated);
                            } else {
                              onClose();
                            }
                          } catch {
                            toast({ title: "Failed to release past plan", variant: "destructive" });
                          }
                        }}
                      >
                        {releaseMut.isPending ? "Releasing…" : "Confirm release"}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmRelease(false)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-center gap-1.5"
                      onClick={() => setConfirmRelease(true)}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      Release {Math.round(pastPlanDays * 10) / 10}d past undelivered plan
                    </Button>
                  )
                ) : (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    {hasPast
                      ? "No undelivered past days to release."
                      : "This slot has no past days yet."}
                    {hasFuture ? " Future plan is intact." : ""}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Shared role plan — identical for every slot on this role ───────── */}
          {roleId && roleBudgetStatus && (() => {
            const {
              budgetedDays,
              loggedDays,
              invoicedDays,
              reservedDays,
              unplannedDays,
              freeDays,
              remainingBudgetDays,
              bookings: roleBookings,
            } = roleBudgetStatus;
            const r1 = (n: number) => Math.round(n * 10) / 10;
            const thisDays = booksAgainstBudget ?? 0;
            const selectedRole = projectRoles?.find((r) => String(r.id) === roleId);
            const empName = isEdit
              ? (employees.find((e) => e.id === employeeId)?.name ?? "Employee")
              : (state as ModalState).employeeName;

            if (budgetedDays == null) {
              return (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex items-start gap-2">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    No budget defined for this role — slots aren't checked against a budget.
                    Set a budgeted-days figure on the role to enable tracking.
                  </span>
                </div>
              );
            }

            const unplanned = unplannedDays ?? 0;
            const statusColor = (val: number) =>
              val > 10
                ? "text-green-700 dark:text-green-400"
                : val >= 0
                  ? "text-yellow-700 dark:text-yellow-400"
                  : "text-destructive";

            const todayStr = new Date().toISOString().slice(0, 10);

            // Live vs projected: roleBudgetStatus already includes the saved
            // slot (edit) or excludes the not-yet-created slot (create). To
            // preview unsaved edits without double-counting, project Unplanned
            // by only the CHANGE in this slot's budget-days.
            const released = isEdit
              ? !!(state as EditModalState).booking.pastReleasedAt
              : false;
            const effDays = (
              s: string,
              e: string,
              hpd: number,
              wh: Record<string, number> | null,
            ): number => {
              if (!s || !e || e < s) return 0;
              if (!released)
                return calcBookingHoursClient(s, e, hpd, wh, workingDaysMask, holidayDates, vacations).budgetDays;
              if (e < todayStr) return 0;
              return calcBookingHoursClient(s >= todayStr ? s : todayStr, e, hpd, wh, workingDaysMask, holidayDates, vacations).budgetDays;
            };
            const savedSlotDays = isEdit
              ? effDays(
                  (state as EditModalState).booking.startDate,
                  (state as EditModalState).booking.endDate,
                  (state as EditModalState).booking.hoursPerDay,
                  (state as EditModalState).booking.weekdayHours,
                )
              : 0;
            const editedSlotDays = booksAgainstBudget ?? 0;
            const slotDelta = r1(editedSlotDays - savedSlotDays);
            const unplannedProjected = r1(unplanned - slotDelta);
            const showProjected = Math.abs(slotDelta) >= 0.05;
            const mySlots = allBookings
              .filter((b) => b.employeeId === employeeId && String(b.projectRoleId) === roleId)
              .sort((a, b) => a.startDate.localeCompare(b.startDate));
            const currentId = isEdit ? (state as EditModalState).booking.id : null;

            return (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-foreground">
                    Role budget
                    {selectedRole ? (
                      <span className="font-normal text-muted-foreground"> — {selectedRole.name}</span>
                    ) : null}
                  </div>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    live · matches Budget tab
                  </span>
                </div>

                {/* Canonical buckets (8h-day equivalents) */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Budgeted</span>
                    <span className="font-medium text-foreground">{budgetedDays}d</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Logged</span>
                    <span className="text-foreground">{r1(loggedDays)}d</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Invoiced</span>
                    <span className="text-foreground">{r1(invoicedDays)}d</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Re-plannable</span>
                    <span className="text-blue-600 dark:text-blue-400 font-medium">{r1(reservedDays)}d</span>
                  </div>
                  <div className={`flex justify-between ${statusColor(unplanned)}`}>
                    <span>Unplanned</span>
                    <span className="font-medium">{r1(unplanned)}d</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Free</span>
                    <span className="text-foreground">{freeDays != null ? r1(freeDays) + "d" : "—"}</span>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground border-t border-border/40 pt-1.5">
                  Budgeted = Invoiced + Re-plannable + Unplanned. Remaining (Budgeted − Invoiced):{" "}
                  <span className="text-foreground font-medium">
                    {remainingBudgetDays != null ? r1(remainingBudgetDays) + "d" : "—"}
                  </span>
                </div>

                {/* Live vs projected effect of THIS slot */}
                {showProjected ? (
                  <div className="rounded-md bg-background/60 border border-border/60 px-2.5 py-1.5 space-y-0.5">
                    <div className="flex justify-between font-medium text-foreground">
                      <span>
                        {isEdit
                          ? slotDelta >= 0
                            ? "Your edits add"
                            : "Your edits free"
                          : "This slot books"}
                      </span>
                      <span>
                        {isEdit
                          ? (slotDelta >= 0 ? "+" : "−") + r1(Math.abs(slotDelta)) + "d"
                          : "+" + r1(editedSlotDays) + "d"}
                      </span>
                    </div>
                    <div className={`flex justify-between ${statusColor(unplannedProjected)}`}>
                      <span>Unplanned after {isEdit ? "saving" : "adding"}</span>
                      <span className="font-medium">{unplannedProjected}d</span>
                    </div>
                  </div>
                ) : isEdit ? (
                  <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      These figures are live and already include this slot — they
                      match the Budget tab. Change the dates or hours to preview
                      your edit.
                    </span>
                  </div>
                ) : null}
                {showProjected && unplannedProjected < 0 && (
                  <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-2.5 py-2 text-destructive text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      {isEdit ? "After saving, this" : "This"} slot would exceed the
                      unplanned budget by {r1(Math.abs(unplannedProjected))}d.
                      Options: reduce this slot, release past undelivered plan, or
                      increase the role budget.
                    </span>
                  </div>
                )}

                {/* This employee's slots on this role (each booking = a slot) */}
                {mySlots.length > 0 && (
                  <div className="border-t border-border/40 pt-1.5 space-y-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {empName}'s slots on this role
                    </div>
                    {mySlots.map((b) => {
                      const bd = calcBookingHoursClient(
                        b.startDate, b.endDate, b.hoursPerDay, b.weekdayHours,
                        workingDaysMask, holidayDates, vacations,
                      ).budgetDays;
                      const isCur = currentId != null && b.id === currentId;
                      const rel = !!b.pastReleasedAt;
                      return (
                        <div
                          key={b.id}
                          className={`flex items-center justify-between rounded px-1.5 py-1 text-xs ${isCur ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {isCur && <span className="text-primary font-semibold">●</span>}
                            <span className="truncate">
                              {format(parseISO(b.startDate), "d MMM")} – {format(parseISO(b.endDate), "d MMM yy")}
                            </span>
                            {rel && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground border border-border rounded px-1">
                                <Clock className="h-2.5 w-2.5" /> released
                              </span>
                            )}
                            {isCur && <span className="text-[10px] text-primary">this slot</span>}
                          </span>
                          <span className="shrink-0 ml-2 text-muted-foreground">
                            {r1(bd)}d planned{b.endDate < todayStr && !rel ? " · has past" : ""}
                          </span>
                        </div>
                      );
                    })}
                    {!isEdit && thisDays > 0 && (
                      <div className="flex items-center justify-between rounded px-1.5 py-1 text-xs bg-primary/10 ring-1 ring-primary/30">
                        <span className="flex items-center gap-1.5">
                          <span className="text-primary font-semibold">＋</span>
                          {startDate && endDate
                            ? `${format(parseISO(startDate), "d MMM")} – ${format(parseISO(endDate), "d MMM yy")}`
                            : "new slot"}
                          <span className="text-[10px] text-primary">new slot</span>
                        </span>
                        <span className="shrink-0 ml-2 text-muted-foreground">+{r1(thisDays)}d</span>
                      </div>
                    )}
                  </div>
                )}

                {/* All employees on this role */}
                {roleBookings.length > 0 && (
                  <div className="border-t border-border/40 pt-1.5 space-y-0.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      All employees on this role
                    </div>
                    {roleBookings.map((rb) => (
                      <div key={rb.employeeId} className="flex justify-between text-xs text-muted-foreground/80">
                        <span className="truncate max-w-[150px]">{rb.employeeName}</span>
                        <span className="shrink-0 ml-2">
                          {r1(rb.days)}d planned · {r1(rb.loggedDays)}d logged
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Legend — definitions (strictly per replit.md) */}
                <div className="border-t border-border/40 pt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground">What these mean: </span>
                  <b>Planned</b> = days booked. <b>Logged</b> = hours recorded ÷ 8. <b>Invoiced</b> = billed (locked).{" "}
                  <b>Re-plannable</b> = planned but not yet delivered (movable). <b>Unplanned</b> = budget not yet committed.{" "}
                  <b>Free</b> = Budgeted − Logged. All figures are 8h-day equivalents.
                </div>
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
              <span className="text-sm text-muted-foreground">Are you sure?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
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
  const [excludedProjectIds, setExcludedProjectIds] = useState<Set<number>>(
    new Set(),
  );
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filterSearch, setFilterSearch] = useState("");
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

  function openCloseOutModal(b: ResourceBookingFull) {
    const emp = (employees as any[]).find((e) => e.id === b.employeeId);
    setModal({
      mode: "edit",
      booking: b,
      capacity: b.weeklyCapacityHours,
      workingDaysMask: Array.isArray(emp?.workingDaysMask)
        ? emp.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: emp?.holidayCalendarCode ?? null,
      openInConfirmRelease: true,
    });
  }

  function handleBookingUpdated(updatedBooking: ResourceBookingFull) {
    setModal((prev) => {
      if (!prev || prev.mode !== "edit") return prev;
      return { ...prev, booking: updatedBooking, openInConfirmRelease: false };
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

  const todayStr = format(today, "yyyy-MM-dd");
  const contentWidth = numWeeks * cellWidth;

  const allActiveEmployees = useMemo(
    () => (employees as any[]).filter((e) => e.active !== false),
    [employees],
  );

  // ── Project filter panel data ─────────────────────────────────────────────
  const projectsByClient = useMemo(() => {
    const projectMap = new Map<
      number,
      { id: number; name: string; clientName: string; color: string }
    >();
    for (const b of bookings as ResourceBookingFull[]) {
      if (!projectMap.has(b.projectId)) {
        projectMap.set(b.projectId, {
          id: b.projectId,
          name: b.projectName,
          clientName: b.clientName ?? "No Client",
          color: resolveProjectColor(b.projectId, b.projectColor),
        });
      }
    }
    const clientMap = new Map<
      string,
      { id: number; name: string; clientName: string; color: string }[]
    >();
    for (const [, proj] of projectMap) {
      if (!clientMap.has(proj.clientName)) clientMap.set(proj.clientName, []);
      clientMap.get(proj.clientName)!.push(proj);
    }
    return [...clientMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([clientName, projs]) => ({
        clientName,
        projects: [...projs].sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [bookings]);

  const filteredProjectGroups = useMemo(() => {
    if (!filterSearch.trim()) return projectsByClient;
    const q = filterSearch.toLowerCase();
    return projectsByClient
      .map((g) => ({
        ...g,
        projects: g.projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            g.clientName.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.projects.length > 0);
  }, [projectsByClient, filterSearch]);

  // ── Filtered + sorted employees ─────────────────────────────────────────────
  const activeEmployees = useMemo(() => {
    return [...allActiveEmployees].sort((a: any, b: any) => {
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
  }, [allActiveEmployees, bookings, sortMode]);

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

  // ── Additive project color patch (fire-and-forget on first load) ─────────
  const qc = useQueryClient();
  const colorPatchedRef = useRef(false);
  useEffect(() => {
    if (colorPatchedRef.current || !(projects as any[]).length) return;
    const colorless = (projects as any[]).filter((p: any) => !p.color);
    if (!colorless.length) {
      colorPatchedRef.current = true;
      return;
    }
    colorPatchedRef.current = true;
    colorless.forEach((p: any) => {
      const color = PROJECT_COLORS[p.id % PROJECT_COLORS.length];
      fetch(`/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ color }),
      })
        .then((r) => {
          if (r.ok)
            qc.invalidateQueries({
              queryKey: getListProjectsQueryKey({ includeInactive: false }),
            });
        })
        .catch(() => {});
    });
  }, [projects, qc]);

  // ── Per-employee holiday date sets ────────────────────────────────────────
  const holidayDateSetByEmployee = useMemo(() => {
    const result: Record<number, Set<string>> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      result[id] = new Set((holidaysByEmployee[id] ?? []).map((h) => h.date));
    }
    return result;
  }, [activeEmployees, holidaysByEmployee]);

  // ── Per-employee vacation day maps (date → VacationEntry) ────────────────
  const vacationDayMapByEmployee = useMemo(() => {
    const wsStr = format(windowStart, "yyyy-MM-dd");
    const weStr = format(addDays(windowEnd, -1), "yyyy-MM-dd");
    const result: Record<number, Map<string, VacationEntry>> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      const dayMap = new Map<string, VacationEntry>();
      for (const v of vacationsByEmployee[id] ?? []) {
        const start = v.startDate < wsStr ? wsStr : v.startDate;
        const end = v.endDate > weStr ? weStr : v.endDate;
        if (start > end) continue;
        let d = parseISO(start);
        const eDate = parseISO(end);
        while (d <= eDate) {
          dayMap.set(format(d, "yyyy-MM-dd"), v);
          d = addDays(d, 1);
        }
      }
      result[id] = dayMap;
    }
    return result;
  }, [activeEmployees, vacationsByEmployee, windowStart, windowEnd]);

  // ── Booking segments (day-level, precomputed per employee) ────────────────
  const segmentsByEmployee = useMemo(() => {
    const result: Record<number, Segment[]> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      const empMask: number[] = Array.isArray((emp as any).workingDaysMask)
        ? (emp as any).workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0];
      const holidayDateSet =
        holidayDateSetByEmployee[id] ?? new Set<string>();
      const vacationDayMap =
        vacationDayMapByEmployee[id] ?? new Map<string, VacationEntry>();
      const vacationDateSet = new Set(vacationDayMap.keys());
      const empBookings = (bookingsByEmployee[id] ?? []).filter(
        (b) => !excludedProjectIds.has(b.projectId),
      );
      const allSegs: SegmentBase[] = [];
      for (const b of empBookings) {
        const color = resolveProjectColor(b.projectId, b.projectColor);
        allSegs.push(
          ...buildBookingSegments(
            b,
            windowStart,
            numWeeks,
            color,
            empMask,
            holidayDateSet,
            vacationDateSet,
          ),
        );
      }
      result[id] = assignSegmentLanes(allSegs);
    }
    return result;
  }, [
    activeEmployees,
    bookingsByEmployee,
    excludedProjectIds,
    windowStart,
    numWeeks,
    holidayDateSetByEmployee,
    vacationDayMapByEmployee,
  ]);

  // ── Filtered employee list (hide when all bookings excluded by filter) ────
  const visibleEmployees = useMemo(() => {
    if (excludedProjectIds.size === 0) return activeEmployees;
    return activeEmployees.filter((emp: any) => {
      const allBookings = bookingsByEmployee[(emp as any).id] ?? [];
      if (allBookings.length === 0) return true; // no bookings → show "Available"
      return (segmentsByEmployee[(emp as any).id] ?? []).length > 0;
    });
  }, [activeEmployees, excludedProjectIds, bookingsByEmployee, segmentsByEmployee]);

  // ── Daily hours totals per employee/day (sum across ALL booking segments) ──
  const dailyTotalsMap = useMemo(() => {
    const result: Record<number, Record<string, number>> = {};
    for (const [empIdStr, segs] of Object.entries(segmentsByEmployee)) {
      const id = Number(empIdStr);
      const dayTotals: Record<string, number> = {};
      for (const seg of segs) {
        for (let i = 0; i < seg.dailyHours.length; i++) {
          const dateStr = format(
            addDays(windowStart, seg.startOffset + i),
            "yyyy-MM-dd",
          );
          dayTotals[dateStr] = (dayTotals[dateStr] ?? 0) + seg.dailyHours[i];
        }
      }
      result[id] = dayTotals;
    }
    return result;
  }, [segmentsByEmployee, windowStart]);

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
            {/* Projects filter popover */}
            <Popover open={filterPanelOpen} onOpenChange={setFilterPanelOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Filter className="h-3.5 w-3.5" />
                  Projects
                  {excludedProjectIds.size > 0 && (
                    <span className="ml-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 leading-none">
                      {excludedProjectIds.size}
                    </span>
                  )}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                {/* Search */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    placeholder="Search projects…"
                    value={filterSearch}
                    onChange={(e) => setFilterSearch(e.target.value)}
                    className="h-7 border-0 shadow-none px-0 py-0 text-sm focus-visible:ring-0"
                  />
                  {filterSearch && (
                    <button
                      onClick={() => setFilterSearch("")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Project list grouped by client */}
                <div className="max-h-72 overflow-y-auto py-1">
                  {filteredProjectGroups.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                      No projects found
                    </div>
                  ) : (
                    filteredProjectGroups.map((group) => {
                      const allVisible = group.projects.every(
                        (p) => !excludedProjectIds.has(p.id),
                      );
                      const someVisible = group.projects.some(
                        (p) => !excludedProjectIds.has(p.id),
                      );
                      return (
                        <div key={group.clientName}>
                          {/* Client header — toggle-all */}
                          <div
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 cursor-pointer"
                            onClick={() => {
                              setExcludedProjectIds((prev) => {
                                const next = new Set(prev);
                                if (allVisible) {
                                  group.projects.forEach((p) =>
                                    next.add(p.id),
                                  );
                                } else {
                                  group.projects.forEach((p) =>
                                    next.delete(p.id),
                                  );
                                }
                                return next;
                              });
                            }}
                          >
                            <span
                              className={`flex h-4 w-4 items-center justify-center rounded border shrink-0 ${
                                allVisible
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : someVisible
                                    ? "border-primary"
                                    : "border-input"
                              }`}
                            >
                              {allVisible && <Check className="h-3 w-3" />}
                              {!allVisible && someVisible && (
                                <Minus className="h-2 w-2 text-primary" />
                              )}
                            </span>
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide truncate">
                              {group.clientName}
                            </span>
                          </div>

                          {/* Projects in this client group */}
                          {group.projects.map((p) => {
                            const visible = !excludedProjectIds.has(p.id);
                            return (
                              <div
                                key={p.id}
                                className="flex items-center gap-2 pl-8 pr-3 py-1 hover:bg-muted/50 cursor-pointer"
                                onClick={() => {
                                  setExcludedProjectIds((prev) => {
                                    const next = new Set(prev);
                                    if (visible) {
                                      next.add(p.id);
                                    } else {
                                      next.delete(p.id);
                                    }
                                    return next;
                                  });
                                }}
                              >
                                <span
                                  className={`flex h-4 w-4 items-center justify-center rounded border shrink-0 ${visible ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}
                                >
                                  {visible && <Check className="h-3 w-3" />}
                                </span>
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: p.color }}
                                />
                                <span className="text-sm truncate">
                                  {p.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-3 py-2 border-t border-border">
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setExcludedProjectIds(new Set())}
                  >
                    Show all
                  </button>
                  {excludedProjectIds.size > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {excludedProjectIds.size} hidden
                    </span>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Clear filter */}
            {excludedProjectIds.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => setExcludedProjectIds(new Set())}
              >
                Clear filter
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
            {visibleEmployees.length === 0 && (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No active employees found.
              </div>
            )}

            {visibleEmployees.map((emp: any) => {
              const empId: number = emp.id;
              const empBookings = bookingsByEmployee[empId] ?? [];
              const cap: number = emp.weeklyCapacityHours ?? 40;
              const empMask: number[] = Array.isArray(emp.workingDaysMask)
                ? emp.workingDaysMask
                : [1, 1, 1, 1, 1, 0, 0];
              const dailyCap = getDailyCapacity(cap, empMask);
              const dayWidth = cellWidth / 7;

              const holidayDateSet =
                holidayDateSetByEmployee[empId] ?? new Set<string>();
              const vacationDayMap =
                vacationDayMapByEmployee[empId] ??
                new Map<string, VacationEntry>();

              const baseSegments = segmentsByEmployee[empId] ?? [];
              const laneCount =
                baseSegments.length > 0
                  ? Math.max(...baseSegments.map((s) => s.lane)) + 1
                  : 0;
              const barH = laneCount > 1 ? BAR_H_STACKED : BAR_H_SINGLE;
              const rowHeight = calcRowHeight(laneCount);
              const hiddenCount = baseSegments.filter(
                (s) => s.lane >= MAX_VISIBLE_LANES,
              ).length;

              return (
                <div
                  key={empId}
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
                        {cap}h/week · {dailyCap.toFixed(1)}h/day
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
                      const clickDayOffset = Math.floor(offsetX / dayWidth);
                      const clampedOffset = Math.max(
                        0,
                        Math.min(clickDayOffset, numWeeks * 7 - 1),
                      );
                      const clickedDate = format(
                        addDays(windowStart, clampedOffset),
                        "yyyy-MM-dd",
                      );
                      openCreateVacationModal(emp, clickedDate, clickedDate);
                    }}
                  >
                    {/* Week grid background */}
                    <div className="flex h-full absolute inset-0">
                      {weeks.map((_w, i) => (
                        <div
                          key={i}
                          className="shrink-0 border-r border-border/30 last:border-r-0"
                          style={{ width: cellWidth, height: "100%" }}
                        />
                      ))}
                    </div>

                    {/* Per-day absence cells — holidays and vacations */}
                    {Array.from({ length: numWeeks * 7 }, (_, offset) => {
                      const day = addDays(windowStart, offset);
                      const dayStr = format(day, "yyyy-MM-dd");
                      const left = offset * dayWidth;

                      if (holidayDateSet.has(dayStr)) {
                        const holiday = (holidaysByEmployee[empId] ?? []).find(
                          (h) => h.date === dayStr,
                        );
                        return (
                          <Tooltip key={`h-${offset}`}>
                            <TooltipTrigger asChild>
                              <div
                                className="absolute flex items-center justify-center pointer-events-auto"
                                style={{
                                  top: 0,
                                  bottom: 0,
                                  left,
                                  width: dayWidth,
                                  backgroundColor: "rgba(156,163,175,0.18)",
                                  zIndex: 2,
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {dayWidth >= 12 && (
                                  <Star className="h-3 w-3 text-gray-400" />
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              className="text-xs space-y-0.5"
                            >
                              <div className="font-semibold">
                                {holiday?.name ?? "Public holiday"}
                              </div>
                              <div>{format(day, "MMM d, yyyy")}</div>
                            </TooltipContent>
                          </Tooltip>
                        );
                      }

                      const vacation = vacationDayMap.get(dayStr);
                      if (vacation) {
                        const icon =
                          vacation.vacationType === "vacation" ? (
                            <Sun className="h-3 w-3 text-orange-400" />
                          ) : vacation.vacationType === "sick" ? (
                            <Thermometer className="h-3 w-3 text-red-400" />
                          ) : (
                            <X className="h-3 w-3 text-gray-400" />
                          );
                        return (
                          <Tooltip key={`v-${offset}`}>
                            <TooltipTrigger asChild>
                              <div
                                role="button"
                                tabIndex={0}
                                aria-label={`Edit ${vacation.vacationType.replace(/_/g, " ")} for ${emp.name}`}
                                className="absolute flex items-center justify-center pointer-events-auto cursor-pointer hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                style={{
                                  top: 0,
                                  bottom: 0,
                                  left,
                                  width: dayWidth,
                                  backgroundColor: "rgba(251,146,60,0.14)",
                                  zIndex: 2,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEditVacationModal(vacation, emp.name);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ")
                                    openEditVacationModal(vacation, emp.name);
                                }}
                              >
                                {dayWidth >= 12 && icon}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              className="text-xs space-y-0.5"
                            >
                              <div className="font-semibold capitalize">
                                {vacation.vacationType.replace(/_/g, " ")}
                              </div>
                              <div>
                                {format(parseISO(vacation.startDate), "MMM d")}{" "}
                                –{" "}
                                {format(
                                  parseISO(vacation.endDate),
                                  "MMM d, yyyy",
                                )}
                              </div>
                              {vacation.note && (
                                <div className="text-muted-foreground italic">
                                  {vacation.note}
                                </div>
                              )}
                              <div className="text-muted-foreground text-[10px] pt-0.5">
                                Click to edit
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        );
                      }

                      // Empty working day — dashed border cell
                      const isoD =
                        day.getDay() === 0 ? 6 : day.getDay() - 1;
                      const isWorkingDay = empMask[isoD] === 1;
                      const dayTotal =
                        (dailyTotalsMap[empId] ?? {})[dayStr] ?? 0;
                      if (!isWorkingDay || dayTotal > 0) return null;
                      return (
                        <div
                          key={`empty-${offset}`}
                          style={{
                            position: "absolute",
                            top: BAR_PAD_TOP,
                            height: barH,
                            left,
                            width: dayWidth,
                            border: "1px dashed rgba(0,0,0,0.10)",
                            borderRadius: 2,
                            zIndex: 1,
                            pointerEvents: "none",
                          }}
                        />
                      );
                    })}

                    {/* "Available" label when no visible segments */}
                    {baseSegments.length === 0 && (
                      <div className="absolute inset-0 flex items-center px-4 pointer-events-none">
                        <span className="text-xs text-muted-foreground/40 select-none">
                          Available
                        </span>
                      </div>
                    )}

                    {/* Booking segments — proportional bottom-fill per day */}
                    {baseSegments.map((seg) => {
                      if (seg.lane >= MAX_VISIBLE_LANES) return null;
                      const isDragging =
                        dragGhost?.bookingId === seg.bookingId;
                      const barTop =
                        BAR_PAD_TOP + seg.lane * (barH + BAR_GAP);
                      const left = seg.startOffset * dayWidth;
                      const width =
                        (seg.endOffset - seg.startOffset + 1) * dayWidth;
                      const showCloseOut =
                        !isDragging &&
                        !seg.pastReleasedAt &&
                        seg.bookingStartDate < todayStr &&
                        width > 32;
                      const segKey = `seg-${seg.bookingId}-${seg.startOffset}`;

                      const barDiv = (
                        <div
                          className={`absolute overflow-hidden group/bar${isDragging ? "" : " transition-all"}`}
                          style={{
                            top: barTop,
                            height: barH,
                            left,
                            width,
                            borderRadius: 3,
                            opacity: isDragging ? 0.35 : 1,
                            cursor: isDragging ? "grabbing" : "grab",
                            zIndex: isDragging ? 5 : 4,
                            userSelect: "none",
                            border: `1px solid ${seg.color}60`,
                            backgroundColor: `${seg.color}18`,
                          }}
                          onMouseDown={(e) => {
                            const booking = empBookings.find(
                              (b) => b.id === seg.bookingId,
                            );
                            if (booking)
                              startBookingDrag(e, booking, "move", dayWidth);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Per-day proportional fill bars */}
                          <div
                            className="absolute inset-0 flex"
                            style={{ borderRadius: 3, overflow: "hidden" }}
                          >
                            {seg.dailyHours.map((h, i) => {
                              const fill =
                                dailyCap > 0
                                  ? Math.min(1, h / dailyCap)
                                  : 0;
                              const isOver =
                                dailyCap > 0 && h > dailyCap;
                              return (
                                <div
                                  key={i}
                                  style={{
                                    width: dayWidth,
                                    flexShrink: 0,
                                    position: "relative",
                                    borderLeft:
                                      i > 0
                                        ? "1px solid rgba(255,255,255,0.25)"
                                        : undefined,
                                  }}
                                >
                                  <div
                                    style={{
                                      position: "absolute",
                                      bottom: 0,
                                      left: 0,
                                      right: 0,
                                      height: `${fill * 100}%`,
                                      backgroundColor: isOver
                                        ? "rgba(239,68,68,0.80)"
                                        : `${seg.color}CC`,
                                    }}
                                  />
                                </div>
                              );
                            })}
                          </div>

                          {/* Role/project name text */}
                          {width > 20 && (
                            <div
                              className="absolute inset-0 flex items-center px-1.5 pointer-events-none"
                              style={{ zIndex: 2 }}
                            >
                              <span
                                className="text-[10px] font-semibold truncate select-none leading-none"
                                style={{
                                  color: seg.color,
                                  filter:
                                    "drop-shadow(0 0 3px rgba(255,255,255,0.9))",
                                }}
                              >
                                {seg.roleName ?? seg.projectName}
                              </span>
                            </div>
                          )}

                          {/* Past-released indicator */}
                          {seg.pastReleasedAt && width > 24 && (
                            <div
                              className="absolute top-0.5 right-1.5 pointer-events-none"
                              style={{ zIndex: 2 }}
                            >
                              <Clock
                                className="h-3 w-3"
                                style={{ color: seg.color, opacity: 0.7 }}
                              />
                            </div>
                          )}

                          {/* Close Out button */}
                          {showCloseOut && (
                            <button
                              type="button"
                              className="absolute top-0.5 right-1.5 opacity-0 group-hover/bar:opacity-100 transition-opacity rounded p-0.5 hover:bg-black/10 focus:outline-none"
                              style={{ zIndex: 6, cursor: "pointer" }}
                              title="Close Out — release undelivered past days"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const booking = empBookings.find(
                                  (b) => b.id === seg.bookingId,
                                );
                                if (booking) openCloseOutModal(booking);
                              }}
                            >
                              <Clock
                                className="h-3 w-3"
                                style={{ color: seg.color }}
                              />
                            </button>
                          )}

                          {/* Left resize handle */}
                          <div
                            className="absolute top-0 left-0 h-full"
                            style={{
                              width: 7,
                              cursor: "ew-resize",
                              zIndex: 3,
                            }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              const booking = empBookings.find(
                                (b) => b.id === seg.bookingId,
                              );
                              if (booking)
                                startBookingDrag(
                                  e,
                                  booking,
                                  "resize-start",
                                  dayWidth,
                                );
                            }}
                          />

                          {/* Right resize handle */}
                          <div
                            className="absolute top-0 right-0 h-full"
                            style={{
                              width: 7,
                              cursor: "ew-resize",
                              zIndex: 3,
                            }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              const booking = empBookings.find(
                                (b) => b.id === seg.bookingId,
                              );
                              if (booking)
                                startBookingDrag(
                                  e,
                                  booking,
                                  "resize-end",
                                  dayWidth,
                                );
                            }}
                          />
                        </div>
                      );

                      if (isDragging) {
                        return (
                          <div key={segKey} style={{ display: "contents" }}>
                            {barDiv}
                          </div>
                        );
                      }

                      return (
                        <Tooltip key={segKey}>
                          <TooltipTrigger asChild>{barDiv}</TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="text-xs max-w-[240px] p-0"
                          >
                            <div className="px-3 pt-2.5 pb-1.5">
                              <div className="font-semibold text-gray-900">
                                {seg.projectName}
                              </div>
                              {seg.clientName && (
                                <div className="text-gray-500">
                                  {seg.clientName}
                                </div>
                              )}
                            </div>
                            <div className="px-3 pb-2 space-y-0.5 border-t border-gray-200 pt-1.5">
                              {seg.roleName && (
                                <div className="text-primary font-medium">
                                  {seg.roleName}
                                  {seg.dayRate
                                    ? ` — €${seg.dayRate.toLocaleString("de-DE")}/day`
                                    : ""}
                                </div>
                              )}
                              <div className="text-gray-700">
                                {format(
                                  parseISO(seg.bookingStartDate),
                                  "MMM d",
                                )}{" "}
                                –{" "}
                                {format(
                                  parseISO(seg.bookingEndDate),
                                  "MMM d, yyyy",
                                )}
                              </div>
                              <div className="text-gray-700">
                                {(() => {
                                  const bk = empBookings.find(
                                    (b) => b.id === seg.bookingId,
                                  );
                                  if (!bk) return null;
                                  if (bk.weekdayHours) {
                                    const wh = bk.weekdayHours as Record<
                                      string,
                                      number
                                    >;
                                    const days = ["Mo", "Tu", "We", "Th", "Fr"];
                                    const parts = Object.entries(wh)
                                      .filter(([, v]) => v > 0)
                                      .map(
                                        ([k, v]) =>
                                          `${days[Number(k) - 1] ?? k}: ${v.toFixed(1).replace(/\.0$/, "")}h`,
                                      );
                                    return parts.join(" · ");
                                  }
                                  return `${(bk.hoursPerDay ?? 0).toFixed(1).replace(/\.0$/, "")}h/day`;
                                })()}
                              </div>
                              {seg.notes && (
                                <div className="text-gray-500 italic">
                                  {seg.notes}
                                </div>
                              )}
                              {seg.pastReleasedAt && (
                                <div className="flex items-center gap-1 text-amber-600 font-medium">
                                  <Clock className="h-3 w-3" />
                                  Past plan released
                                </div>
                              )}
                            </div>
                            {seg.projectRoleId &&
                              (() => {
                                const rb = roleBudgetMap.get(
                                  seg.projectRoleId,
                                );
                                if (!rb || rb.budgetedDays == null)
                                  return null;
                                const isOver =
                                  rb.plannedDays > rb.budgetedDays;
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

                    {/* Per-day free/over labels based on daily total across all bookings */}
                    {dayWidth > 28 &&
                      barH >= 18 &&
                      Array.from({ length: numWeeks * 7 }, (_, offset) => {
                        const day = addDays(windowStart, offset);
                        const dayStr = format(day, "yyyy-MM-dd");
                        const isoD =
                          day.getDay() === 0 ? 6 : day.getDay() - 1;
                        if (!empMask[isoD]) return null;
                        if (
                          holidayDateSet.has(dayStr) ||
                          vacationDayMap.has(dayStr)
                        )
                          return null;
                        const total =
                          (dailyTotalsMap[empId] ?? {})[dayStr] ?? 0;
                        if (total === 0 || dailyCap === 0) return null;
                        const freeH = dailyCap - total;
                        if (Math.abs(freeH) < 0.1) return null;
                        const isOverDay = freeH < 0;
                        return (
                          <div
                            key={`lbl-${offset}`}
                            style={{
                              position: "absolute",
                              top: BAR_PAD_TOP + 2,
                              left: offset * dayWidth,
                              width: dayWidth,
                              height: barH - 4,
                              display: "flex",
                              alignItems: "flex-end",
                              justifyContent: "flex-end",
                              paddingRight: 2,
                              paddingBottom: 1,
                              fontSize: 8,
                              fontWeight: 700,
                              lineHeight: 1,
                              color: isOverDay
                                ? "rgb(185,28,28)"
                                : "rgba(0,0,0,0.42)",
                              zIndex: 7,
                              pointerEvents: "none",
                              userSelect: "none",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {isOverDay
                              ? `-${(-freeH).toFixed(1).replace(/\.0$/, "")}h`
                              : `${freeH.toFixed(1).replace(/\.0$/, "")}h free`}
                          </div>
                        );
                      })}

                    {/* Ghost bar for active drag */}
                    {dragGhost &&
                      empBookings.some(
                        (b) => b.id === dragGhost.bookingId,
                      ) &&
                      (() => {
                        const bounds = getBarBounds(
                          dragGhost.startDate,
                          dragGhost.endDate,
                          windowStart,
                          numWeeks,
                          cellWidth,
                        );
                        if (!bounds) return null;
                        const dragged = empBookings.find(
                          (b) => b.id === dragGhost.bookingId,
                        )!;
                        const color = resolveProjectColor(
                          dragged.projectId,
                          dragged.projectColor,
                        );
                        return (
                          <div
                            className="absolute pointer-events-none rounded-sm flex items-center px-2"
                            style={{
                              top: BAR_PAD_TOP,
                              height: BAR_H_SINGLE,
                              left: bounds.left,
                              width: bounds.width,
                              backgroundColor: color,
                              opacity: 0.85,
                              zIndex: 6,
                              userSelect: "none",
                            }}
                          >
                            {bounds.width > 48 && (
                              <span className="text-white text-[10px] font-semibold truncate">
                                {format(
                                  parseISO(dragGhost.startDate),
                                  "MMM d",
                                )}{" "}
                                –{" "}
                                {format(parseISO(dragGhost.endDate), "MMM d")}
                              </span>
                            )}
                          </div>
                        );
                      })()}

                    {/* "+N more" indicator */}
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
            key={
              modal.mode === "edit"
                ? `edit-${(modal as EditModalState).booking.id}`
                : "create"
            }
            state={modal}
            projects={projects as any[]}
            allBookings={bookings}
            employees={activeEmployees}
            onClose={() => setModal(null)}
            onBookingUpdated={handleBookingUpdated}
            initialConfirmRelease={
              modal.mode === "edit"
                ? (modal as EditModalState).openInConfirmRelease
                : false
            }
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
