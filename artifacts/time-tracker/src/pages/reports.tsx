import { useState, useMemo, useCallback } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  format,
  startOfWeek, endOfWeek,
  startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter,
  startOfYear, endOfYear,
  subWeeks, subMonths, subQuarters, subYears,
  parseISO,
} from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  useListEmployees,
  useListProjects,
  useListClients,
} from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, X, Save, Trash2, BookOpen } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";

// ─── Date preset helpers ────────────────────────────────────────────────────

type Preset =
  | "today" | "this_week" | "last_week"
  | "this_month" | "last_month"
  | "this_quarter" | "last_quarter"
  | "this_year" | "last_year"
  | "custom";

const PRESET_LABELS: Record<Preset, string> = {
  today:          "Today",
  this_week:      "This Week",
  last_week:      "Last Week",
  this_month:     "This Month",
  last_month:     "Last Month",
  this_quarter:   "This Quarter",
  last_quarter:   "Last Quarter",
  this_year:      "This Year",
  last_year:      "Last Year",
  custom:         "Custom",
};

function toIso(d: Date) {
  return format(d, "yyyy-MM-dd");
}

function presetsFor(preset: Preset): { startDate: string; endDate: string } {
  const now = new Date();
  switch (preset) {
    case "today":         return { startDate: toIso(now), endDate: toIso(now) };
    case "this_week":     return { startDate: toIso(startOfWeek(now, { weekStartsOn: 1 })), endDate: toIso(endOfWeek(now, { weekStartsOn: 1 })) };
    case "last_week":     return { startDate: toIso(startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })), endDate: toIso(endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })) };
    case "this_month":    return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
    case "last_month":    return { startDate: toIso(startOfMonth(subMonths(now, 1))), endDate: toIso(endOfMonth(subMonths(now, 1))) };
    case "this_quarter":  return { startDate: toIso(startOfQuarter(now)), endDate: toIso(endOfQuarter(now)) };
    case "last_quarter":  return { startDate: toIso(startOfQuarter(subQuarters(now, 1))), endDate: toIso(endOfQuarter(subQuarters(now, 1))) };
    case "this_year":     return { startDate: toIso(startOfYear(now)), endDate: toIso(endOfYear(now)) };
    case "last_year":     return { startDate: toIso(startOfYear(subYears(now, 1))), endDate: toIso(endOfYear(subYears(now, 1))) };
    default:              return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

type RowDimension = "employees" | "projects" | "clients";
type ColDimension = "none" | "month";
type Metric =
  | "billable_hours"
  | "total_hours"
  | "billable_utilization_percent"
  | "overall_utilization_percent"
  | "booked_hours"
  | "budget_hours"
  | "remaining_hours"
  | "budget_used_pct";

interface FlatRow {
  id: number;
  label: string;
  availableHours: number;
  billableHours: number;
  nonBillableHours: number;
  totalHours: number;
  billableUtilization: number;
  overallUtilization: number;
  // budget fields (only present for projects / clients)
  budgetHours?: number | null;
  bookedHours?: number;
  remainingHours?: number | null;
  budgetUsedPct?: number | null;
}

interface PivotRow {
  id: number;
  label: string;
  values: Record<string, number>;
}

type ReportData =
  | { type: "flat"; rowDimension: string; rows: FlatRow[] }
  | { type: "pivot"; rowDimension: string; colDimension: string; metric: string; columns: string[]; rows: PivotRow[] };

// ─── Saved report types & helpers ────────────────────────────────────────────

interface ReportConfig {
  preset: Preset;
  startDate: string;
  endDate: string;
  rowDimension: RowDimension;
  colDimension: ColDimension;
  metric: Metric;
  filterEmployees: number[];
  filterProjects: number[];
  filterClients: number[];
}

interface SavedReportRow {
  id: string;
  name: string;
  config: string;
  createdAt: string;
  updatedAt: string;
}

async function fetchSavedReports(): Promise<SavedReportRow[]> {
  const res = await fetch("/api/saved-reports");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiCreateSavedReport(name: string, config: ReportConfig): Promise<SavedReportRow> {
  const res = await fetch("/api/saved-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config: JSON.stringify(config) }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiDeleteSavedReport(id: string): Promise<void> {
  const res = await fetch(`/api/saved-reports/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(await res.text());
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

async function fetchPivot(params: URLSearchParams): Promise<ReportData> {
  const res = await fetch(`/api/reports/pivot?${params.toString()}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatMetricValue(metric: Metric | string, value: number): string {
  if (
    metric === "billable_utilization_percent" ||
    metric === "overall_utilization_percent" ||
    metric === "budget_used_pct"
  ) {
    return `${Math.round(value * 100)}%`;
  }
  return value.toFixed(1);
}

function formatMonthLabel(yyyymm: string): string {
  try {
    return format(parseISO(yyyymm + "-01"), "MMM yyyy");
  } catch {
    return yyyymm;
  }
}

function utilizationColor(value: number): string {
  const pct = value * 100;
  if (pct >= 80) return "text-emerald-600 font-semibold";
  if (pct >= 60) return "text-foreground";
  if (pct >= 40) return "text-amber-600";
  return "text-red-500";
}

function isPctMetric(metric: Metric | string): boolean {
  return (
    metric === "billable_utilization_percent" ||
    metric === "overall_utilization_percent" ||
    metric === "budget_used_pct"
  );
}

// ─── Multi-select badge component ────────────────────────────────────────────

interface MultiSelectProps {
  label: string;
  options: { id: number; label: string }[];
  selected: number[];
  onChange: (ids: number[]) => void;
}

function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const available = options.filter((o) => !selected.includes(o.id));

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1 min-h-[36px] border rounded-md px-2 py-1.5 bg-background">
        {selected.map((id) => {
          const opt = options.find((o) => o.id === id);
          if (!opt) return null;
          return (
            <Badge key={id} variant="secondary" className="gap-1 h-6 text-xs">
              {opt.label}
              <button
                onClick={() => onChange(selected.filter((s) => s !== id))}
                className="rounded-sm opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          );
        })}
        {available.length > 0 && (
          <Select
            onValueChange={(v) => onChange([...selected, parseInt(v, 10)])}
            value=""
          >
            <SelectTrigger className="h-6 w-auto border-none shadow-none px-1 text-xs text-muted-foreground hover:text-foreground bg-transparent">
              <SelectValue placeholder="+ Add filter" />
            </SelectTrigger>
            <SelectContent>
              {available.map((o) => (
                <SelectItem key={o.id} value={String(o.id)} className="text-sm">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {selected.length === 0 && available.length === 0 && (
          <span className="text-xs text-muted-foreground">All</span>
        )}
        {selected.length === 0 && available.length > 0 && (
          <span className="text-xs text-muted-foreground pointer-events-none">All (click to filter)</span>
        )}
      </div>
    </div>
  );
}

// ─── CSV export ──────────────────────────────────────────────────────────────

function exportCSV(data: ReportData, metric: Metric, startDate: string, endDate: string, rowDimension: RowDimension) {
  let lines: string[] = [];
  const showBudget = rowDimension === "projects" || rowDimension === "clients";

  if (data.type === "flat") {
    if (rowDimension === "employees") {
      lines.push(["Name","Available Hrs","Billable Hrs","Non-Billable Hrs","Total Hrs","Billable Util%","Overall Util%"].join(","));
      data.rows.forEach((r) => {
        lines.push([
          `"${r.label}"`,
          r.availableHours,
          r.billableHours,
          r.nonBillableHours,
          r.totalHours,
          `${Math.round(r.billableUtilization * 100)}%`,
          `${Math.round(r.overallUtilization * 100)}%`,
        ].join(","));
      });
    } else {
      lines.push(["Name","Budget Hrs","Booked Hrs","Logged Hrs","Remaining Hrs","Budget Used %","Billable Hrs","Non-Billable Hrs"].join(","));
      data.rows.forEach((r) => {
        lines.push([
          `"${r.label}"`,
          r.budgetHours != null ? r.budgetHours.toFixed(1) : "—",
          r.bookedHours != null ? r.bookedHours.toFixed(1) : "0.0",
          r.totalHours.toFixed(1),
          r.remainingHours != null ? r.remainingHours.toFixed(1) : "—",
          r.budgetUsedPct != null ? `${Math.round(r.budgetUsedPct * 100)}%` : "—",
          r.billableHours.toFixed(1),
          r.nonBillableHours.toFixed(1),
        ].join(","));
      });
    }
  } else {
    const colLabels = data.columns.map(formatMonthLabel);
    lines.push(["Name", ...colLabels].join(","));
    data.rows.forEach((r) => {
      const cells = data.columns.map((c) => formatMetricValue(metric, r.values[c] ?? 0));
      lines.push([`"${r.label}"`, ...cells].join(","));
    });
  }

  const csv  = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `report_${startDate}_${endDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function Reports() {
  const now = new Date();

  const [preset, setPreset]               = useState<Preset>("this_month");
  const [startDate, setStartDate]         = useState(() => presetsFor("this_month").startDate);
  const [endDate, setEndDate]             = useState(() => presetsFor("this_month").endDate);
  const [rowDimension, setRowDimension]   = useState<RowDimension>("employees");
  const [colDimension, setColDimension]   = useState<ColDimension>("none");
  const [metric, setMetric]               = useState<Metric>("billable_utilization_percent");
  const [filterEmployees, setFilterEmployees] = useState<number[]>([]);
  const [filterProjects, setFilterProjects]   = useState<number[]>([]);
  const [filterClients, setFilterClients]     = useState<number[]>([]);

  // ── Saved reports state ──────────────────────────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName]             = useState("");
  const [saveError, setSaveError]           = useState("");

  const queryClient = useQueryClient();

  const { data: savedReports = [] } = useQuery<SavedReportRow[]>({
    queryKey: ["saved-reports"],
    queryFn: fetchSavedReports,
  });

  const createReport = useMutation({
    mutationFn: ({ name, config }: { name: string; config: ReportConfig }) =>
      apiCreateSavedReport(name, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-reports"] });
      setSaveDialogOpen(false);
      setSaveName("");
      setSaveError("");
    },
  });

  const deleteReport = useMutation({
    mutationFn: (id: string) => apiDeleteSavedReport(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["saved-reports"] }),
  });

  const handleOpenSaveDialog = () => {
    setSaveName("");
    setSaveError("");
    setSaveDialogOpen(true);
  };

  const handleConfirmSave = () => {
    const trimmed = saveName.trim();
    if (!trimmed) {
      setSaveError("Please enter a name for the report.");
      return;
    }
    const config: ReportConfig = {
      preset, startDate, endDate,
      rowDimension, colDimension, metric,
      filterEmployees, filterProjects, filterClients,
    };
    createReport.mutate({ name: trimmed, config });
  };

  const handleLoadReport = (row: SavedReportRow) => {
    try {
      const cfg: ReportConfig = JSON.parse(row.config);
      setPreset(cfg.preset ?? "custom");
      setStartDate(cfg.startDate);
      setEndDate(cfg.endDate);
      setRowDimension(cfg.rowDimension ?? "employees");
      setColDimension(cfg.colDimension ?? "none");
      setMetric(cfg.metric ?? "billable_utilization_percent");
      setFilterEmployees(cfg.filterEmployees ?? []);
      setFilterProjects(cfg.filterProjects ?? []);
      setFilterClients(cfg.filterClients ?? []);
    } catch {
      // malformed config — ignore
    }
  };

  const { data: employees } = useListEmployees();
  const { data: projects }  = useListProjects({ includeInactive: false });
  const { data: allProjects } = useListProjects({ includeInactive: true });
  const { data: clients }   = useListClients();

  const projectColorMap = useMemo(() => {
    const map = new Map<number, string>();
    (allProjects ?? []).forEach((p) => {
      map.set(p.id, p.color ?? "#6366f1");
    });
    return map;
  }, [allProjects]);

  const employeeOptions = useMemo(
    () => (employees ?? []).map((e) => ({ id: e.id, label: e.name })),
    [employees]
  );
  const projectOptions = useMemo(
    () => (projects ?? []).map((p) => ({ id: p.id, label: `${p.name} (${p.clientName ?? "—"})` })),
    [projects]
  );
  const clientOptions = useMemo(
    () => (clients ?? []).map((c) => ({ id: c.id, label: c.name })),
    [clients]
  );

  const showBudgetColumns = rowDimension === "projects" || rowDimension === "clients";

  // Build query params
  const params = useMemo(() => {
    const p = new URLSearchParams({
      startDate,
      endDate,
      rowDimension,
      colDimension,
      metric,
    });
    if (filterEmployees.length) p.set("employeeIds", filterEmployees.join(","));
    if (filterProjects.length)  p.set("projectIds",  filterProjects.join(","));
    if (filterClients.length)   p.set("clientIds",   filterClients.join(","));
    return p;
  }, [startDate, endDate, rowDimension, colDimension, metric, filterEmployees, filterProjects, filterClients]);

  const { data, isLoading, error } = useQuery<ReportData>({
    queryKey: ["reports-pivot", params.toString()],
    queryFn: () => fetchPivot(params),
    enabled: !!startDate && !!endDate,
  });

  const handlePreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const { startDate: s, endDate: e } = presetsFor(p);
      setStartDate(s);
      setEndDate(e);
    }
  };

  const handleDateChange = (field: "start" | "end", value: string) => {
    setPreset("custom");
    if (field === "start") setStartDate(value);
    else setEndDate(value);
  };

  const isUtilizationMetric =
    metric === "billable_utilization_percent" || metric === "overall_utilization_percent";

  const showAvailableHours =
    data?.type === "flat" && rowDimension === "employees";

  // Flat table column count (for empty-state colSpan)
  const flatColCount = rowDimension === "employees"
    ? 7  // name + available + billable + non-billable + total + 2 util
    : 8; // name + budget + booked + logged + remaining + budget% + billable + non-billable

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>

        {/* ── Control bar ─────────────────────────────────────────────── */}
        <div className="space-y-4 p-4 border rounded-lg bg-card shadow-sm">

          {/* Row 1: Date range */}
          <div className="flex flex-wrap items-end gap-3">
            {/* Preset */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Period</Label>
              <Select value={preset} onValueChange={(v) => handlePreset(v as Preset)}>
                <SelectTrigger className="w-[160px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                    <SelectItem key={p} value={p}>{PRESET_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Custom dates */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => handleDateChange("start", e.target.value)}
                className="h-9 w-[150px]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => handleDateChange("end", e.target.value)}
                className="h-9 w-[150px]"
              />
            </div>
          </div>

          {/* Row 2: Dimensions + metric */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Rows</Label>
              <Select value={rowDimension} onValueChange={(v) => setRowDimension(v as RowDimension)}>
                <SelectTrigger className="w-[150px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="employees">Employees</SelectItem>
                  <SelectItem value="projects">Projects</SelectItem>
                  <SelectItem value="clients">Clients</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Columns</Label>
              <Select value={colDimension} onValueChange={(v) => setColDimension(v as ColDimension)}>
                <SelectTrigger className="w-[150px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None (summary)</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {colDimension === "month" && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Metric</Label>
                <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
                  <SelectTrigger className="w-[240px] h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="billable_hours">Billable Hours</SelectItem>
                    <SelectItem value="total_hours">Total Hours</SelectItem>
                    <SelectItem value="billable_utilization_percent">Billable Utilization %</SelectItem>
                    <SelectItem value="overall_utilization_percent">Overall Utilization %</SelectItem>
                    {showBudgetColumns && (
                      <>
                        <SelectItem value="booked_hours">Booked Hours</SelectItem>
                        <SelectItem value="budget_hours">Budget Hours</SelectItem>
                        <SelectItem value="remaining_hours">Remaining Hours</SelectItem>
                        <SelectItem value="budget_used_pct">Budget Used %</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Row 3: Filters */}
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[220px] flex-1">
              <MultiSelect
                label="Filter Employees"
                options={employeeOptions}
                selected={filterEmployees}
                onChange={setFilterEmployees}
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <MultiSelect
                label="Filter Projects"
                options={projectOptions}
                selected={filterProjects}
                onChange={setFilterProjects}
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <MultiSelect
                label="Filter Clients"
                options={clientOptions}
                selected={filterClients}
                onChange={setFilterClients}
              />
            </div>
          </div>
        </div>

        {/* ── Saved Reports list ──────────────────────────────────────── */}
        {savedReports.length > 0 && (
          <div className="border rounded-lg bg-card p-3 shadow-sm space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BookOpen className="h-4 w-4" />
              Saved Reports
            </div>
            <div className="divide-y divide-border">
              {savedReports.map((r) => {
                let summary = "";
                try {
                  const cfg: ReportConfig = JSON.parse(r.config);
                  const presetLabel = cfg.preset !== "custom" ? PRESET_LABELS[cfg.preset] : `${cfg.startDate} → ${cfg.endDate}`;
                  summary = `${presetLabel} · ${cfg.rowDimension}`;
                } catch { /* empty */ }
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <button
                      className="flex-1 text-left hover:text-primary transition-colors min-w-0"
                      onClick={() => handleLoadReport(r)}
                    >
                      <span className="font-medium text-sm truncate block">{r.name}</span>
                      {summary && (
                        <span className="text-xs text-muted-foreground">{summary}</span>
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                      disabled={deleteReport.isPending}
                      onClick={() => deleteReport.mutate(r.id)}
                      title="Delete saved report"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Table ───────────────────────────────────────────────────── */}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenSaveDialog}
          >
            <Save className="h-4 w-4 mr-2" /> Save Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || (data.rows.length === 0)}
            onClick={() => data && exportCSV(data, metric, startDate, endDate, rowDimension)}
          >
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
        </div>

        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {error && (
          <div className="border border-destructive/30 bg-destructive/10 text-destructive rounded-md p-4 text-sm">
            Failed to load report. Please check the date range and try again.
          </div>
        )}

        {/* FLAT table */}
        {!isLoading && data?.type === "flat" && (
          <div className="border rounded-md bg-card overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="min-w-[180px]">Name</TableHead>
                  {rowDimension === "employees" ? (
                    <>
                      {showAvailableHours && (
                        <TableHead className="text-right">Available Hrs</TableHead>
                      )}
                      <TableHead className="text-right">Billable Hrs</TableHead>
                      <TableHead className="text-right">Non-Billable Hrs</TableHead>
                      <TableHead className="text-right">Total Hrs</TableHead>
                      <TableHead className="text-right">Billable Util</TableHead>
                      <TableHead className="text-right">Overall Util</TableHead>
                    </>
                  ) : (
                    <>
                      <TableHead className="text-right">Budget Hrs</TableHead>
                      <TableHead className="text-right">Booked Hrs</TableHead>
                      <TableHead className="text-right">Logged Hrs</TableHead>
                      <TableHead className="text-right">Remaining Hrs</TableHead>
                      <TableHead className="text-right">Budget Used %</TableHead>
                      <TableHead className="text-right">Billable Hrs</TableHead>
                      <TableHead className="text-right">Non-Billable Hrs</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={flatColCount}
                      className="text-center py-12 text-muted-foreground"
                    >
                      No data for the selected period and filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {rowDimension === "projects" ? (
                          <div className="flex items-center gap-2">
                            <span
                              className="shrink-0 w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: projectColorMap.get(row.id) ?? "#6366f1" }}
                            />
                            {row.label}
                          </div>
                        ) : row.label}
                      </TableCell>

                      {rowDimension === "employees" ? (
                        <>
                          {showAvailableHours && (
                            <TableCell className="text-right text-muted-foreground">
                              {row.availableHours.toFixed(1)}
                            </TableCell>
                          )}
                          <TableCell className="text-right text-primary font-medium">
                            {row.billableHours.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {row.nonBillableHours.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {row.totalHours.toFixed(1)}
                          </TableCell>
                          <TableCell className={`text-right ${utilizationColor(row.billableUtilization)}`}>
                            {Math.round(row.billableUtilization * 100)}%
                          </TableCell>
                          <TableCell className={`text-right ${utilizationColor(row.overallUtilization)}`}>
                            {Math.round(row.overallUtilization * 100)}%
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="text-right text-muted-foreground">
                            {row.budgetHours != null ? row.budgetHours.toFixed(1) : <span className="text-muted-foreground/40">—</span>}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {(row.bookedHours ?? 0).toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {row.totalHours.toFixed(1)}
                          </TableCell>
                          <TableCell className={`text-right font-medium ${
                            row.remainingHours != null && row.remainingHours < 0
                              ? "text-red-500"
                              : row.remainingHours != null
                              ? "text-emerald-600"
                              : "text-muted-foreground/40"
                          }`}>
                            {row.remainingHours != null
                              ? row.remainingHours.toFixed(1)
                              : <span>—</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.budgetUsedPct != null
                              ? `${Math.round(row.budgetUsedPct * 100)}%`
                              : <span className="text-muted-foreground/40">—</span>}
                          </TableCell>
                          <TableCell className="text-right text-primary">
                            {row.billableHours.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {row.nonBillableHours.toFixed(1)}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* PIVOT table */}
        {!isLoading && data?.type === "pivot" && (
          <div className="border rounded-md bg-card overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead className="min-w-[180px] sticky left-0 bg-muted/30 z-10">Name</TableHead>
                  {data.columns.map((col) => (
                    <TableHead key={col} className="text-right min-w-[100px] whitespace-nowrap">
                      {formatMonthLabel(col)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={data.columns.length + 1}
                      className="text-center py-12 text-muted-foreground"
                    >
                      No data for the selected period and filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium sticky left-0 bg-card z-10">
                        {rowDimension === "projects" ? (
                          <div className="flex items-center gap-2">
                            <span
                              className="shrink-0 w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: projectColorMap.get(row.id) ?? "#6366f1" }}
                            />
                            {row.label}
                          </div>
                        ) : row.label}
                      </TableCell>
                      {data.columns.map((col) => {
                        const val = row.values[col] ?? 0;
                        const isEmpty = val === 0;
                        const isNegative = metric === "remaining_hours" && val < 0;
                        const colorClass =
                          isNegative
                            ? "text-red-500 font-medium"
                            : isUtilizationMetric && !isEmpty
                            ? utilizationColor(val)
                            : "";
                        return (
                          <TableCell
                            key={col}
                            className={`text-right tabular-nums ${colorClass} ${isEmpty ? "text-muted-foreground/40" : ""}`}
                          >
                            {isEmpty
                              ? "—"
                              : formatMetricValue(metric, val)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ── Save Report Dialog ─────────────────────────────────────────── */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Save Report Configuration</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="save-report-name">Report Name</Label>
              <Input
                id="save-report-name"
                placeholder="e.g. Q1 Billable Utilization"
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); setSaveError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirmSave(); }}
                autoFocus
              />
              {saveError && (
                <p className="text-xs text-destructive">{saveError}</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Saves the current date range, grouping, metric, and filters.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirmSave}
              disabled={createReport.isPending}
            >
              {createReport.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
