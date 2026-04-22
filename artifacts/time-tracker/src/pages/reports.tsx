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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Download, X, Save, Trash2, BookOpen, ChevronRight, ChevronDown, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── Date preset helpers ─────────────────────────────────────────────────────

type Preset =
  | "today" | "this_week" | "last_week"
  | "this_month" | "last_month"
  | "this_quarter" | "last_quarter"
  | "this_year" | "last_year"
  | "custom";

const PRESET_LABELS: Record<Preset, string> = {
  today:        "Today",
  this_week:    "This Week",
  last_week:    "Last Week",
  this_month:   "This Month",
  last_month:   "Last Month",
  this_quarter: "This Quarter",
  last_quarter: "Last Quarter",
  this_year:    "This Year",
  last_year:    "Last Year",
  custom:       "Custom",
};

function toIso(d: Date) {
  return format(d, "yyyy-MM-dd");
}

function presetsFor(preset: Preset): { startDate: string; endDate: string } {
  const now = new Date();
  switch (preset) {
    case "today":        return { startDate: toIso(now), endDate: toIso(now) };
    case "this_week":    return { startDate: toIso(startOfWeek(now, { weekStartsOn: 1 })), endDate: toIso(endOfWeek(now, { weekStartsOn: 1 })) };
    case "last_week":    return { startDate: toIso(startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })), endDate: toIso(endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })) };
    case "this_month":   return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
    case "last_month":   return { startDate: toIso(startOfMonth(subMonths(now, 1))), endDate: toIso(endOfMonth(subMonths(now, 1))) };
    case "this_quarter": return { startDate: toIso(startOfQuarter(now)), endDate: toIso(endOfQuarter(now)) };
    case "last_quarter": return { startDate: toIso(startOfQuarter(subQuarters(now, 1))), endDate: toIso(endOfQuarter(subQuarters(now, 1))) };
    case "this_year":    return { startDate: toIso(startOfYear(now)), endDate: toIso(endOfYear(now)) };
    case "last_year":    return { startDate: toIso(startOfYear(subYears(now, 1))), endDate: toIso(endOfYear(subYears(now, 1))) };
    default:             return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type RowDimension = "employees" | "projects" | "clients" | "roles";
type ColDimension = "none" | "week" | "month" | "quarter";
type Unit = "hours" | "days";

const ALL_METRICS: { key: string; label: string }[] = [
  { key: "booked",                label: "Booked" },
  { key: "billable_booked",       label: "Billable Booked" },
  { key: "planned",               label: "Planned" },
  { key: "available",             label: "Available" },
  { key: "budgeted",              label: "Budgeted" },
  { key: "remaining_unbooked",    label: "Remaining (unbooked)" },
  { key: "remaining_unplanned",   label: "Remaining (unplanned)" },
  { key: "utilization_pct",       label: "Utilization %" },
  { key: "billable_utilization_pct", label: "Billable Util %" },
  { key: "plan_completion_pct",   label: "Plan Completion %" },
  { key: "budget_used_pct",       label: "Budget Used %" },
];

const METRIC_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ALL_METRICS.map((m) => [m.key, m.label])
);

const PCT_METRICS = new Set([
  "utilization_pct", "billable_utilization_pct",
  "plan_completion_pct", "budget_used_pct",
]);

interface DrillRow {
  id: string;
  name: string;
  type: string;
  expandable: boolean;
  data: Record<string, Record<string, number>>;
  children: DrillRow[];
}

interface DrillResponse {
  type: "drill";
  rowDimension: string;
  colDimension: string;
  metrics: string[];
  columns: string[];
  columnLabels: string[];
  rows: DrillRow[];
  totals: Record<string, Record<string, number>>;
}

// ─── Saved report config ─────────────────────────────────────────────────────

interface ReportConfig {
  preset: Preset;
  startDate: string;
  endDate: string;
  rowDimension: RowDimension;
  colDimension: ColDimension;
  metrics: string[];
  unit: Unit;
  filterEmployees: number[];
  filterProjects: number[];
  filterClients: number[];
  // legacy compat
  metric?: string;
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

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function fetchPivot(params: URLSearchParams): Promise<DrillResponse> {
  const res = await fetch(`/api/reports/pivot?${params.toString()}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Value formatting ────────────────────────────────────────────────────────

function fmtVal(val: number, metricKey: string, unit: Unit): string {
  if (PCT_METRICS.has(metricKey)) return `${val.toFixed(1)}%`;
  const v = unit === "days" ? val / 8 : val;
  const suffix = unit === "days" ? "d" : "h";
  return `${v.toFixed(1)}${suffix}`;
}

function fmtLabel(col: string): string {
  if (col === "Total") return "Total";
  if (/^\d{4}-W\d+$/.test(col)) {
    const [year, w] = col.split("-W");
    return `W${w} ${year}`;
  }
  if (/^\d{4}-Q\d$/.test(col)) {
    const [year, q] = col.split("-Q");
    return `Q${q} ${year}`;
  }
  if (/^\d{4}-\d{2}$/.test(col)) {
    try { return format(parseISO(col + "-01"), "MMM yyyy"); } catch { return col; }
  }
  return col;
}

// ─── Color helpers ───────────────────────────────────────────────────────────

// Spec: utilization ≥80% green, <80% orange, >100% red
// Spec: remaining <0 red, <20% of budget orange
// Spec: plan_completion >100% red
function metricCellClass(
  metricKey: string,
  val: number,
  rowBudgeted?: number
): string {
  if (metricKey === "utilization_pct" || metricKey === "billable_utilization_pct") {
    if (val > 100) return "text-red-500 font-semibold";
    if (val >= 80)  return "text-emerald-600 font-semibold";
    return "text-amber-500";
  }
  if (metricKey === "plan_completion_pct") {
    if (val > 100) return "text-red-500 font-semibold";
    return "";
  }
  if (metricKey === "remaining_unbooked" || metricKey === "remaining_unplanned") {
    if (val < 0) return "text-red-500 font-semibold";
    if (rowBudgeted != null && rowBudgeted > 0 && val < rowBudgeted * 0.2) return "text-amber-500 font-medium";
    return "";
  }
  return "";
}

// ─── Multi-select filter ─────────────────────────────────────────────────────

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
              <button onClick={() => onChange(selected.filter((s) => s !== id))} className="rounded-sm opacity-60 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          );
        })}
        {available.length > 0 && (
          <Select onValueChange={(v) => onChange([...selected, parseInt(v, 10)])} value="">
            <SelectTrigger className="h-6 w-auto border-none shadow-none px-1 text-xs text-muted-foreground hover:text-foreground bg-transparent">
              <SelectValue placeholder="+ Add filter" />
            </SelectTrigger>
            <SelectContent>
              {available.map((o) => (
                <SelectItem key={o.id} value={String(o.id)} className="text-sm">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {selected.length === 0 && available.length === 0 && <span className="text-xs text-muted-foreground">All</span>}
        {selected.length === 0 && available.length > 0 && <span className="text-xs text-muted-foreground pointer-events-none">All (click to filter)</span>}
      </div>
    </div>
  );
}

// ─── CSV export ──────────────────────────────────────────────────────────────


function exportCSV(
  data: DrillResponse,
  visibleRows: { row: DrillRow; depth: number }[],
  unit: Unit,
  startDate: string,
  endDate: string
) {
  const metrics = data.metrics;
  const colLabels = data.columns.map(fmtLabel);

  const headerCells = ["Name", "Type"];
  for (const col of colLabels) {
    for (const m of metrics) {
      headerCells.push(`${col} - ${METRIC_LABEL_MAP[m] ?? m}`);
    }
  }

  const lines: string[] = [headerCells.join(",")];
  for (const { row, depth } of visibleRows) {
    const indent = "  ".repeat(depth);
    const cells: string[] = [`"${indent}${row.name}"`, row.type];
    for (const col of data.columns) {
      for (const m of metrics) {
        const val = row.data[col]?.[m] ?? 0;
        cells.push(PCT_METRICS.has(m) ? `${val.toFixed(1)}%` : unit === "days" ? `${(val / 8).toFixed(1)}d` : `${val.toFixed(1)}h`);
      }
    }
    lines.push(cells.join(","));
  }

  // Totals row
  const totalCells: string[] = ['"Totals"', "total"];
  for (const col of data.columns) {
    for (const m of metrics) {
      const val = data.totals[col]?.[m] ?? 0;
      totalCells.push(PCT_METRICS.has(m) ? `${val.toFixed(1)}%` : unit === "days" ? `${(val / 8).toFixed(1)}d` : `${val.toFixed(1)}h`);
    }
  }
  lines.push(totalCells.join(","));

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

// ─── Drill-down row component ─────────────────────────────────────────────────

const UTIL_METRICS = new Set(["utilization_pct", "billable_utilization_pct"]);

interface DrillRowProps {
  row: DrillRow;
  depth: number;
  metrics: string[];
  columns: string[];
  unit: Unit;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function DrillTableRow({ row, depth, metrics, columns, unit, expanded, onToggle }: DrillRowProps) {
  const indentPx = depth * 20;

  const rowTypeClass = depth === 0
    ? "font-semibold bg-muted/20"
    : depth === 1
    ? "font-medium"
    : "text-muted-foreground text-sm";

  // Utilization metrics are only meaningful for employee-type rows
  const isEmployee = row.type === "employee";

  return (
    <TableRow className={`${rowTypeClass} hover:bg-muted/30`}>
      <TableCell
        className="sticky left-0 bg-card z-10 min-w-[200px] max-w-[280px]"
        style={{ paddingLeft: `${8 + indentPx}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {row.expandable ? (
            <button
              onClick={() => onToggle(row.id)}
              className="shrink-0 h-4 w-4 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="shrink-0 h-4 w-4" />
          )}
          <span className="truncate">{row.name}</span>
        </div>
      </TableCell>

      {columns.map((col) =>
        metrics.map((m) => {
          // Suppress utilization metrics for non-employee rows
          const suppress = UTIL_METRICS.has(m) && !isEmployee;
          const val = suppress ? 0 : (row.data[col]?.[m] ?? 0);
          const isEmpty = suppress || (val === 0 && !PCT_METRICS.has(m));
          // Use this row's own budgeted for remaining color thresholds
          const rowBudgeted = row.data[col]?.["budgeted"];
          const colorClass = suppress ? "" : metricCellClass(m, val, rowBudgeted);
          return (
            <TableCell
              key={`${col}::${m}`}
              className={`text-right tabular-nums whitespace-nowrap px-3 ${colorClass} ${isEmpty ? "text-muted-foreground/30" : ""}`}
            >
              {isEmpty ? "—" : fmtVal(val, m, unit)}
            </TableCell>
          );
        })
      )}
    </TableRow>
  );
}

// ─── Recursive visible rows ───────────────────────────────────────────────────

function collectVisible(
  rows: DrillRow[],
  expandedIds: Set<string>,
  depth = 0
): { row: DrillRow; depth: number }[] {
  const result: { row: DrillRow; depth: number }[] = [];
  for (const row of rows) {
    result.push({ row, depth });
    if (row.expandable && expandedIds.has(row.id)) {
      result.push(...collectVisible(row.children, expandedIds, depth + 1));
    }
  }
  return result;
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortDir = "asc" | "desc" | null;

function sortRows(
  rows: DrillRow[],
  sortCol: string | null,
  sortDir: SortDir,
  primaryMetric: string
): DrillRow[] {
  if (!sortCol || !sortDir) return rows;
  return [...rows].sort((a, b) => {
    const av = a.data[sortCol]?.[primaryMetric] ?? 0;
    const bv = b.data[sortCol]?.[primaryMetric] ?? 0;
    return sortDir === "asc" ? av - bv : bv - av;
  });
}

// ─── Saved report config summary ─────────────────────────────────────────────

function configSummary(cfg: ReportConfig): string {
  const presetLabel = cfg.preset !== "custom" ? PRESET_LABELS[cfg.preset] : `${cfg.startDate} → ${cfg.endDate}`;
  const rdLabel: Record<string, string> = { employees: "Employees", projects: "Projects", clients: "Clients", roles: "Roles" };
  const rd = rdLabel[cfg.rowDimension] ?? cfg.rowDimension;
  const metricKeys = cfg.metrics ?? (cfg.metric ? [cfg.metric] : ["booked"]);
  const metricLabels = metricKeys.map((k) => METRIC_LABEL_MAP[k] ?? k).join(", ");
  return `${presetLabel} · ${rd} · ${metricLabels}`;
}

// ─── Main component ───────────────────────────────────────────────────────────

const DEFAULT_METRICS = ["booked", "utilization_pct"];

export default function Reports() {
  const [preset, setPreset]             = useState<Preset>("this_month");
  const [startDate, setStartDate]       = useState(() => presetsFor("this_month").startDate);
  const [endDate, setEndDate]           = useState(() => presetsFor("this_month").endDate);
  const [rowDimension, setRowDimension] = useState<RowDimension>("employees");
  const [colDimension, setColDimension] = useState<ColDimension>("none");
  const [metrics, setMetrics]           = useState<string[]>(DEFAULT_METRICS);
  const [unit, setUnit]                 = useState<Unit>("hours");
  const [filterEmployees, setFilterEmployees] = useState<number[]>([]);
  const [filterProjects, setFilterProjects]   = useState<number[]>([]);
  const [filterClients, setFilterClients]     = useState<number[]>([]);

  // expand/collapse
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // sort — cycle: asc → desc → unsorted
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const handleSortCol = (col: string) => {
    if (sortCol !== col) { setSortCol(col); setSortDir("asc"); }
    else if (sortDir === "asc")  setSortDir("desc");
    else { setSortCol(null); setSortDir(null); }
  };

  // "Generate Report" button — applied state tracks what was last fetched
  const [appliedParams, setAppliedParams] = useState<URLSearchParams | null>(null);

  // saved reports
  const [saveDialogOpen, setSaveDialogOpen]       = useState(false);
  const [saveName, setSaveName]                   = useState("");
  const [saveError, setSaveError]                 = useState("");
  const [savedReportsOpen, setSavedReportsOpen]   = useState(true);
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
      setSaveDialogOpen(false); setSaveName(""); setSaveError("");
    },
  });

  const deleteReport = useMutation({
    mutationFn: (id: string) => apiDeleteSavedReport(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["saved-reports"] }),
  });

  const handleLoadReport = (row: SavedReportRow) => {
    try {
      const cfg: ReportConfig = JSON.parse(row.config);
      const sd = cfg.startDate;
      const ed = cfg.endDate;
      const rd = (cfg.rowDimension ?? "employees") as RowDimension;
      const cd = (cfg.colDimension ?? "none") as ColDimension;
      const ms = cfg.metrics ?? (cfg.metric ? [cfg.metric] : DEFAULT_METRICS);
      const fe = cfg.filterEmployees ?? [];
      const fp = cfg.filterProjects ?? [];
      const fc = cfg.filterClients ?? [];
      setPreset(cfg.preset ?? "custom");
      setStartDate(sd);
      setEndDate(ed);
      setRowDimension(rd);
      setColDimension(cd);
      setMetrics(ms);
      setUnit(cfg.unit ?? "hours");
      setFilterEmployees(fe);
      setFilterProjects(fp);
      setFilterClients(fc);
      setExpandedIds(new Set());
      setSortCol(null);
      setSortDir(null);
      // Build and apply params immediately (state updates are async)
      const p = new URLSearchParams({ startDate: sd, endDate: ed, rowDimension: rd, colDimension: cd });
      ms.forEach((m) => p.append("metrics", m));
      if (fe.length) p.set("employeeIds", fe.join(","));
      if (fp.length) p.set("projectIds",  fp.join(","));
      if (fc.length) p.set("clientIds",   fc.join(","));
      setAppliedParams(p);
    } catch { /* malformed config */ }
  };

  const { data: employees }   = useListEmployees();
  const { data: projects }    = useListProjects({ includeInactive: false });
  const { data: allProjects } = useListProjects({ includeInactive: true });
  const { data: clients }     = useListClients();

  const projectColorMap = useMemo(() => {
    const map = new Map<number, string>();
    (allProjects ?? []).forEach((p) => map.set(p.id, p.color ?? "#6366f1"));
    return map;
  }, [allProjects]);

  const employeeOptions = useMemo(() => (employees ?? []).map((e) => ({ id: e.id, label: e.name })), [employees]);
  const projectOptions  = useMemo(() => (projects ?? []).map((p) => ({ id: p.id, label: `${p.name} (${p.clientName ?? "—"})` })), [projects]);
  const clientOptions   = useMemo(() => (clients ?? []).map((c) => ({ id: c.id, label: c.name })), [clients]);

  // Build pending params from current builder state (not yet applied)
  const pendingParams = useMemo(() => {
    const p = new URLSearchParams({ startDate, endDate, rowDimension, colDimension });
    metrics.forEach((m) => p.append("metrics", m));
    if (filterEmployees.length) p.set("employeeIds", filterEmployees.join(","));
    if (filterProjects.length)  p.set("projectIds",  filterProjects.join(","));
    if (filterClients.length)   p.set("clientIds",   filterClients.join(","));
    return p;
  }, [startDate, endDate, rowDimension, colDimension, metrics, filterEmployees, filterProjects, filterClients]);

  const handleGenerate = () => {
    setAppliedParams(pendingParams);
    setExpandedIds(new Set());
    setSortCol(null);
    setSortDir(null);
  };

  const isDirty = appliedParams?.toString() !== pendingParams.toString();

  const { data, isLoading, error } = useQuery<DrillResponse>({
    queryKey: ["reports-pivot", appliedParams?.toString() ?? ""],
    queryFn: () => fetchPivot(appliedParams!),
    enabled: !!appliedParams && metrics.length > 0,
  });

  const handlePreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const { startDate: s, endDate: e } = presetsFor(p);
      setStartDate(s); setEndDate(e);
    }
  };

  const handleDateChange = (field: "start" | "end", value: string) => {
    setPreset("custom");
    if (field === "start") setStartDate(value);
    else setEndDate(value);
  };

  const toggleMetric = (key: string) => {
    setMetrics((prev) =>
      prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]
    );
  };

  // Sorted top-level rows
  const sortedRows = useMemo(() => {
    if (!data) return [];
    return sortRows(data.rows, sortCol, sortDir, metrics[0] ?? "booked");
  }, [data, sortCol, sortDir, metrics]);

  // Visible rows (flatten with expand state)
  const visibleRows = useMemo(
    () => collectVisible(sortedRows, expandedIds),
    [sortedRows, expandedIds]
  );

  const numDataCols = (data?.columns.length ?? 0) * (metrics.length || 1);

  return (
    <AdminLayout>
      <div className="space-y-5 max-w-[1400px] mx-auto">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>

        {/* ── Builder panel ──────────────────────────────────────────────── */}
        <div className="space-y-4 p-4 border rounded-lg bg-card shadow-sm">

          {/* Row 1: Period + unit toggle */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Period</Label>
              <Select value={preset} onValueChange={(v) => handlePreset(v as Preset)}>
                <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                    <SelectItem key={p} value={p}>{PRESET_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={startDate} onChange={(e) => handleDateChange("start", e.target.value)} className="h-9 w-[150px]" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={endDate} onChange={(e) => handleDateChange("end", e.target.value)} className="h-9 w-[150px]" />
            </div>

            {/* Days / Hours toggle */}
            <div className="space-y-1 ml-auto">
              <Label className="text-xs text-muted-foreground">Display as</Label>
              <div className="flex h-9 rounded-md border bg-background overflow-hidden">
                {(["hours", "days"] as Unit[]).map((u) => (
                  <button
                    key={u}
                    onClick={() => setUnit(u)}
                    className={`px-4 text-sm font-medium transition-colors ${
                      unit === u
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {u === "hours" ? "Hours" : "Days"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: Rows + Columns */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Rows</Label>
              <Select value={rowDimension} onValueChange={(v) => { setRowDimension(v as RowDimension); setExpandedIds(new Set()); }}>
                <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employees">Employees</SelectItem>
                  <SelectItem value="projects">Projects</SelectItem>
                  <SelectItem value="clients">Clients</SelectItem>
                  <SelectItem value="roles">Roles</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Columns</Label>
              <Select value={colDimension} onValueChange={(v) => setColDimension(v as ColDimension)}>
                <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Summary (none)</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="quarter">Quarter</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Metrics checkboxes */}
            <div className="flex-1 min-w-[360px] space-y-1">
              <Label className="text-xs text-muted-foreground">Metrics</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
                {ALL_METRICS.map((m) => (
                  <label key={m.key} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <Checkbox
                      checked={metrics.includes(m.key)}
                      onCheckedChange={() => toggleMetric(m.key)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="text-xs text-foreground whitespace-nowrap">{m.label}</span>
                  </label>
                ))}
              </div>
              {metrics.length === 0 && (
                <p className="text-xs text-amber-600">Select at least one metric.</p>
              )}
            </div>
          </div>

          {/* Row 3: Filters + Generate button */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[200px] flex-1">
              <MultiSelect label="Filter Employees" options={employeeOptions} selected={filterEmployees} onChange={setFilterEmployees} />
            </div>
            <div className="min-w-[200px] flex-1">
              <MultiSelect label="Filter Projects" options={projectOptions} selected={filterProjects} onChange={setFilterProjects} />
            </div>
            <div className="min-w-[200px] flex-1">
              <MultiSelect label="Filter Clients" options={clientOptions} selected={filterClients} onChange={setFilterClients} />
            </div>
            <div className="shrink-0">
              <Button
                onClick={handleGenerate}
                disabled={metrics.length === 0}
                className={isDirty ? "ring-2 ring-primary ring-offset-1" : ""}
              >
                Generate Report
              </Button>
            </div>
          </div>
        </div>

        {/* ── Saved reports ────────────────────────────────────────────── */}
        {savedReports.length > 0 && (
          <div className="border rounded-lg bg-card shadow-sm">
            <button
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSavedReportsOpen((o) => !o)}
              aria-expanded={savedReportsOpen}
            >
              <span className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                Saved Reports
                <span className="text-xs text-muted-foreground/60 font-normal">({savedReports.length})</span>
              </span>
              {savedReportsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {savedReportsOpen && (
              <div className="border-t divide-y divide-border px-3 pb-1">
                {savedReports.map((r) => {
                  let summary = "";
                  try { summary = configSummary(JSON.parse(r.config)); } catch { /* ok */ }
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-3 py-2 first:pt-2 last:pb-2">
                      <button className="flex-1 text-left hover:text-primary transition-colors min-w-0" onClick={() => handleLoadReport(r)}>
                        <span className="font-medium text-sm truncate block">{r.name}</span>
                        {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
                      </button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
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
            )}
          </div>
        )}

        {/* ── Action row ────────────────────────────────────────────────── */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => { setSaveName(""); setSaveError(""); setSaveDialogOpen(true); }}>
            <Save className="h-4 w-4 mr-2" /> Save Report
          </Button>
          <Button
            variant="outline" size="sm"
            disabled={!data || data.rows.length === 0}
            onClick={() => data && exportCSV(data, visibleRows, unit, startDate, endDate)}
          >
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
        </div>

        {/* ── Loading / error ───────────────────────────────────────────── */}
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

        {/* ── Drill-down table ──────────────────────────────────────────── */}
        {!isLoading && data && (
          <div className="border rounded-md bg-card overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/30">
                {/* Period header row */}
                <TableRow className="border-b">
                  <TableHead
                    className="sticky left-0 bg-muted/30 z-10 min-w-[200px]"
                    rowSpan={metrics.length > 1 ? 2 : 1}
                  >
                    Name
                  </TableHead>
                  {data.columns.map((col) => {
                    const label = data.columnLabels?.[data.columns.indexOf(col)] ?? fmtLabel(col);
                    const isSorted = sortCol === col;
                    const colSpan = metrics.length;
                    return (
                      <TableHead
                        key={col}
                        colSpan={colSpan}
                        className={`text-center min-w-[${Math.max(90, colSpan * 90)}px] whitespace-nowrap border-l cursor-pointer select-none hover:bg-muted/50 transition-colors ${
                          col === "Total" ? "bg-muted/40" : ""
                        }`}
                        onClick={() => handleSortCol(col)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          {isSorted && sortDir === "asc"  && <ArrowUp className="h-3 w-3" />}
                          {isSorted && sortDir === "desc" && <ArrowDown className="h-3 w-3" />}
                          {!isSorted && <ArrowUpDown className="h-3 w-3 opacity-30" />}
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>

                {/* Metric sub-header row (only when multiple metrics) */}
                {metrics.length > 1 && (
                  <TableRow className="border-b">
                    {data.columns.map((col) =>
                      metrics.map((m) => (
                        <TableHead
                          key={`${col}::${m}`}
                          className={`text-right text-xs font-normal text-muted-foreground whitespace-nowrap px-3 border-l ${
                            col === "Total" ? "bg-muted/40" : ""
                          }`}
                        >
                          {METRIC_LABEL_MAP[m] ?? m}
                        </TableHead>
                      ))
                    )}
                  </TableRow>
                )}
              </TableHeader>

              <TableBody>
                {visibleRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={1 + numDataCols} className="text-center py-12 text-muted-foreground">
                      No data for the selected period and filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleRows.map(({ row, depth }) => (
                    <DrillTableRow
                      key={row.id}
                      row={row}
                      depth={depth}
                      metrics={metrics}
                      columns={data.columns}
                      unit={unit}
                      expanded={expandedIds.has(row.id)}
                      onToggle={toggleExpand}
                    />
                  ))
                )}

                {/* Footer totals row */}
                {data.rows.length > 0 && (
                  <TableRow className="border-t-2 bg-muted/30 font-semibold">
                    <TableCell className="sticky left-0 bg-muted/30 z-10 text-sm" style={{ paddingLeft: "8px" }}>
                      Total
                    </TableCell>
                    {data.columns.map((col) =>
                      metrics.map((m) => {
                        const val = data.totals[col]?.[m] ?? 0;
                        const totalBudgeted = data.totals[col]?.["budgeted"];
                        const colorClass = metricCellClass(m, val, totalBudgeted);
                        return (
                          <TableCell
                            key={`total::${col}::${m}`}
                            className={`text-right tabular-nums whitespace-nowrap px-3 text-sm ${colorClass}`}
                          >
                            {fmtVal(val, m, unit)}
                          </TableCell>
                        );
                      })
                    )}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ── Save Report Dialog ─────────────────────────────────────────────── */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader><DialogTitle>Save Report Configuration</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="save-report-name">Report Name</Label>
              <Input
                id="save-report-name"
                placeholder="e.g. Q1 Billable Utilization"
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); setSaveError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const trimmed = saveName.trim();
                    if (!trimmed) { setSaveError("Please enter a name."); return; }
                    const config: ReportConfig = {
                      preset, startDate, endDate,
                      rowDimension, colDimension, metrics, unit,
                      filterEmployees, filterProjects, filterClients,
                    };
                    createReport.mutate({ name: trimmed, config });
                  }
                }}
                autoFocus
              />
              {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              Saves the current period, grouping, metrics, unit, and filters.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={createReport.isPending}
              onClick={() => {
                const trimmed = saveName.trim();
                if (!trimmed) { setSaveError("Please enter a name."); return; }
                const config: ReportConfig = {
                  preset, startDate, endDate,
                  rowDimension, colDimension, metrics, unit,
                  filterEmployees, filterProjects, filterClients,
                };
                createReport.mutate({ name: trimmed, config });
              }}
            >
              {createReport.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
