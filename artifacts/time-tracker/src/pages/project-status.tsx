import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  BarChart2,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useListProjectStatus } from "@workspace/api-client-react";
import type { ProjectStatusRow } from "@workspace/api-client-react";

// ─── Label maps ───────────────────────────────────────────────────────────────

const GENERAL_STATUS_LABELS: Record<string, string> = {
  planned:     "Planned",
  in_progress: "In Progress",
  on_hold:     "On Hold",
  completed:   "Completed",
  cancelled:   "Cancelled",
};

const RISK_LEVEL_LABELS: Record<string, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
};

// ─── Sort order ───────────────────────────────────────────────────────────────

const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ─── Badge & colour helpers ────────────────────────────────────────────────────

function generalStatusCls(s: string | null) {
  switch (s) {
    case "planned":     return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    case "in_progress": return "bg-green-500/15 text-green-400 border-green-500/25";
    case "on_hold":     return "bg-yellow-500/15 text-yellow-400 border-yellow-500/25";
    case "completed":
    case "cancelled":   return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    default:            return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function riskLevelCls(s: string | null) {
  switch (s) {
    case "low":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "medium": return "bg-orange-500/15 text-orange-400 border-orange-500/25";
    case "high":   return "bg-red-500/15 text-red-400 border-red-500/25";
    default:       return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function StatusBadge({
  value,
  labels,
  cls,
}: {
  value: string | null;
  labels: Record<string, string>;
  cls: (v: string | null) => string;
}) {
  if (!value) return <span className="text-muted-foreground/40 text-xs">—</span>;
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium", cls(value))}>
      {labels[value] ?? value}
    </span>
  );
}

// ─── Trend arrow ──────────────────────────────────────────────────────────────

function TrendArrow({ direction }: { direction: "up" | "down" | "stable" | null }) {
  if (!direction) return null;
  if (direction === "up")
    return <TrendingUp className="h-3.5 w-3.5 text-red-400 shrink-0" strokeWidth={2} />;
  if (direction === "down")
    return <TrendingDown className="h-3.5 w-3.5 text-green-400 shrink-0" strokeWidth={2} />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" strokeWidth={2} />;
}

// ─── Budget mini-bar ──────────────────────────────────────────────────────────

function BudgetCell({
  budgetTotal,
  budgetConsumed,
  budgetAlert,
}: {
  budgetTotal: number | null;
  budgetConsumed: number | null;
  budgetAlert: boolean;
}) {
  if (!budgetTotal || budgetTotal === 0) {
    return <span className="text-muted-foreground/40 text-xs">—</span>;
  }
  const consumed = budgetConsumed ?? 0;
  if (consumed === 0) {
    return <span className="text-muted-foreground/40 text-xs">No hours yet</span>;
  }
  const pct = Math.round((consumed / budgetTotal) * 100);
  const barColor =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-green-500";
  const textColor =
    pct >= 90 ? "text-red-400" : pct >= 70 ? "text-amber-400" : "text-green-400";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden min-w-[48px] relative">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
        {/* 90% alert marker */}
        {budgetTotal > 0 && (
          <div className="absolute top-0 bottom-0 w-px bg-white/20" style={{ left: "90%" }} />
        )}
      </div>
      <span className={cn("text-xs font-medium tabular-nums", textColor)}>{pct}%</span>
    </div>
  );
}

// ─── Updated cell ─────────────────────────────────────────────────────────────

function UpdatedCell({
  latestUpdateAt,
  updateOverdue,
}: {
  latestUpdateAt: string | null;
  updateOverdue: boolean;
}) {
  if (!latestUpdateAt) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400">
        <Clock className="h-3 w-3 shrink-0" />
        Never
      </span>
    );
  }
  const d = new Date(latestUpdateAt);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {format(d, "dd MMM yyyy")}
      </span>
      {updateOverdue ? (
        <span className="flex items-center gap-1 text-xs text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Overdue
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/50">
          {formatDistanceToNowStrict(d, { addSuffix: true })}
        </span>
      )}
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: "red" | "amber" | "green" | "default";
}) {
  const valueCls =
    accent === "red"
      ? "text-red-400"
      : accent === "amber"
      ? "text-amber-400"
      : accent === "green"
      ? "text-green-400"
      : "text-foreground";
  return (
    <div className="rounded-xl border border-white/8 bg-white/2 p-4 flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground/60">{icon}</div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className={cn("text-xl font-semibold tabular-nums", valueCls)}>{value}</p>
      </div>
    </div>
  );
}

// ─── Project colour dot ───────────────────────────────────────────────────────

const PALETTE = [
  "#8B5CF6","#06B6D4","#10B981","#F59E0B",
  "#EF4444","#3B82F6","#EC4899","#F97316",
];
function resolveColor(color: string | null | undefined, id: number): string {
  return color ?? PALETTE[id % PALETTE.length];
}

// ─── Filter chips ─────────────────────────────────────────────────────────────

type QuickFilter = "all" | "attention" | "overdue";

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
        active
          ? "bg-violet-500/20 text-violet-300 border-violet-500/30"
          : "bg-white/4 text-muted-foreground border-white/10 hover:bg-white/8",
      )}
    >
      {children}
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatus() {
  const [, navigate] = useLocation();

  const [search, setSearch]               = useState("");
  const [clientFilter, setClientFilter]   = useState("__all__");
  const [pmFilter, setPmFilter]           = useState("__all__");
  const [quickFilter, setQuickFilter]     = useState<QuickFilter>("all");
  const [completedOpen, setCompletedOpen] = useState(false);
  const [filterOpen, setFilterOpen]       = useState(false);

  const { data, isLoading } = useListProjectStatus();

  const rows = data ?? [];

  const clientOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.clientName).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [rows]);

  const pmOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.pmName).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [rows]);

  // KPI counters
  const kpis = useMemo(() => {
    const active        = rows.filter((r) => r.generalStatus !== "completed" && r.generalStatus !== "cancelled");
    const attention     = active.filter((r) => r.needsAttention);
    const budgetAlerts  = active.filter((r) => r.budgetAlert);
    const overdue       = active.filter((r) => r.updateOverdue);
    return { total: active.length, attention: attention.length, budgetAlerts: budgetAlerts.length, overdue: overdue.length };
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (clientFilter !== "__all__" && r.clientName !== clientFilter) return false;
      if (pmFilter !== "__all__" && r.pmName !== pmFilter) return false;
      return true;
    });
  }, [rows, search, clientFilter, pmFilter]);

  const activeRows = useMemo(() => {
    return filtered
      .filter((r) => r.generalStatus !== "completed" && r.generalStatus !== "cancelled")
      .filter((r) => {
        if (quickFilter === "attention") return r.needsAttention;
        if (quickFilter === "overdue")   return r.updateOverdue;
        return true;
      })
      .sort((a, b) => {
        // Needs-attention rows float to top
        if (a.needsAttention && !b.needsAttention) return -1;
        if (!a.needsAttention && b.needsAttention)  return 1;
        // Then sort by risk
        const riskA = RISK_ORDER[a.riskLevel ?? ""] ?? 3;
        const riskB = RISK_ORDER[b.riskLevel ?? ""] ?? 3;
        if (riskA !== riskB) return riskA - riskB;
        return (a.clientName ?? "").localeCompare(b.clientName ?? "");
      });
  }, [filtered, quickFilter]);

  const completedRows = useMemo(() => {
    return filtered.filter((r) => r.generalStatus === "completed" || r.generalStatus === "cancelled");
  }, [filtered]);

  const colSpan = 6;

  const tableHeader = (
    <TableHeader>
      <TableRow className="border-white/8 hover:bg-transparent">
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide pl-5">Project</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Customer</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">PM</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Health</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Budget</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Updated</TableHead>
      </TableRow>
    </TableHeader>
  );

  function ProjectRow({ row }: { row: ProjectStatusRow }) {
    const dot = resolveColor(row.color, row.id);
    const needsAttention = row.needsAttention;

    return (
      <TableRow
        className={cn(
          "border-white/8 cursor-pointer transition-colors group relative border-l-2",
          needsAttention
            ? "hover:bg-red-500/6 border-l-red-500/60"
            : "hover:bg-white/4 border-l-transparent",
        )}
        onClick={() => navigate(`/project-status/${row.id}`)}
      >
        <TableCell className="font-medium text-sm pl-5">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-white/10"
              style={{ background: dot }}
            />
            {row.name}
          </div>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{row.clientName ?? "—"}</TableCell>
        <TableCell className="text-sm text-muted-foreground">{row.pmName ?? "—"}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <StatusBadge value={row.riskLevel} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} />
            <TrendArrow direction={row.trendDirection as "up" | "down" | "stable" | null} />
          </div>
        </TableCell>
        <TableCell>
          <BudgetCell
            budgetTotal={row.budgetTotal}
            budgetConsumed={row.budgetConsumed}
            budgetAlert={row.budgetAlert}
          />
        </TableCell>
        <TableCell>
          <UpdatedCell latestUpdateAt={row.latestUpdateAt} updateOverdue={row.updateOverdue} />
        </TableCell>
      </TableRow>
    );
  }

  return (
    <AdminLayout>
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Activity className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
        <h1 className="text-xl font-semibold">Project Status</h1>
      </div>

      {/* KPI strip */}
      {!isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <KpiCard
            label="Active projects"
            value={kpis.total}
            icon={<BarChart2 className="h-4 w-4" strokeWidth={1.5} />}
            accent="default"
          />
          <KpiCard
            label="Needs attention"
            value={kpis.attention}
            icon={<Zap className="h-4 w-4" strokeWidth={1.5} />}
            accent={kpis.attention > 0 ? "amber" : "default"}
          />
          <KpiCard
            label="Budget alerts"
            value={kpis.budgetAlerts}
            icon={<AlertTriangle className="h-4 w-4" strokeWidth={1.5} />}
            accent={kpis.budgetAlerts > 0 ? "red" : "default"}
          />
          <KpiCard
            label="Update overdue"
            value={kpis.overdue}
            icon={<Clock className="h-4 w-4" strokeWidth={1.5} />}
            accent={kpis.overdue > 0 ? "amber" : "default"}
          />
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Input
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52"
        />

        {/* Single Filter button + Popover */}
        {(() => {
          const activeCount = (clientFilter !== "__all__" ? 1 : 0) + (pmFilter !== "__all__" ? 1 : 0);
          return (
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("gap-1.5 h-9", activeCount > 0 && "border-violet-500/50 text-violet-300")}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Filter
                  {activeCount > 0 && (
                    <span className="inline-flex items-center justify-center h-4 min-w-4 rounded-full bg-violet-500/30 text-violet-200 text-[10px] font-bold px-1">
                      {activeCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="start">
                <div className="space-y-4">
                  {/* Customer group */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Customer</p>
                    <div className="space-y-1">
                      {["__all__", ...clientOptions].map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setClientFilter(opt)}
                          className={cn(
                            "w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors",
                            clientFilter === opt
                              ? "bg-violet-500/20 text-violet-300"
                              : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
                          )}
                        >
                          {opt === "__all__" ? "All customers" : opt}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* PM group */}
                  {pmOptions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">PM</p>
                      <div className="space-y-1">
                        {["__all__", ...pmOptions].map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setPmFilter(opt)}
                            className={cn(
                              "w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors",
                              pmFilter === opt
                                ? "bg-violet-500/20 text-violet-300"
                                : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
                            )}
                          >
                            {opt === "__all__" ? "All PMs" : opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Clear */}
                  {activeCount > 0 && (
                    <button
                      type="button"
                      onClick={() => { setClientFilter("__all__"); setPmFilter("__all__"); }}
                      className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          );
        })()}

        {/* Quick-filter chips */}
        <div className="flex items-center gap-2 ml-auto">
          <FilterChip active={quickFilter === "all"} onClick={() => setQuickFilter("all")}>
            All
          </FilterChip>
          <FilterChip active={quickFilter === "attention"} onClick={() => setQuickFilter("attention")}>
            <Zap className="h-3 w-3" />
            Needs attention
            {kpis.attention > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-4 rounded-full bg-amber-500/30 text-amber-300 text-[10px] font-bold px-1">
                {kpis.attention}
              </span>
            )}
          </FilterChip>
          <FilterChip active={quickFilter === "overdue"} onClick={() => setQuickFilter("overdue")}>
            <Clock className="h-3 w-3" />
            Update overdue
            {kpis.overdue > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-4 rounded-full bg-amber-500/30 text-amber-300 text-[10px] font-bold px-1">
                {kpis.overdue}
              </span>
            )}
          </FilterChip>
        </div>
      </div>

      {/* Active projects table */}
      <div className="rounded-xl border border-white/8 overflow-hidden mb-4">
        <Table>
          {tableHeader}
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan + 1} className="text-center text-muted-foreground py-12 text-sm">
                  Loading…
                </TableCell>
              </TableRow>
            ) : activeRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan + 1} className="text-center text-muted-foreground py-12 text-sm">
                  {rows.length === 0 ? "No projects found." : "No active projects match your filters."}
                </TableCell>
              </TableRow>
            ) : (
              activeRows.map((row) => <ProjectRow key={row.id} row={row} />)
            )}
          </TableBody>
        </Table>
      </div>

      {/* Completed projects accordion */}
      {completedRows.length > 0 && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <button
            type="button"
            onClick={() => setCompletedOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-3 bg-white/2 hover:bg-white/4 transition-colors text-left"
          >
            {completedOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" strokeWidth={1.5} />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" strokeWidth={1.5} />
            )}
            <span className="text-sm text-muted-foreground">
              Show {completedRows.length} completed / cancelled project{completedRows.length !== 1 ? "s" : ""}
            </span>
          </button>
          {completedOpen && (
            <Table>
              {tableHeader}
              <TableBody>
                {completedRows.map((row) => <ProjectRow key={row.id} row={row} />)}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          {activeRows.length} active
          {completedRows.length > 0 ? `, ${completedRows.length} completed/cancelled` : ""}
          {filtered.length !== rows.length ? ` (filtered from ${rows.length} total)` : ""}
        </p>
      )}
    </AdminLayout>
  );
}
