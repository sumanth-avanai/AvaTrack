import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectStatusRow {
  id: number;
  name: string;
  clientName: string | null;
  pmName: string | null;
  generalStatus: string | null;
  riskLevel: string | null;
  clientSatisfaction: string | null;
  latestUpdateAt: string | null;
  latestComment: string | null;
  budgetTotal: number | null;
  budgetConsumed: number | null;
}

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

const CLIENT_SATISFACTION_LABELS: Record<string, string> = {
  happy:    "Happy",
  neutral:  "Neutral",
  critical: "Critical",
};

// ─── Risk sort order ──────────────────────────────────────────────────────────

const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ─── Badge helpers ────────────────────────────────────────────────────────────

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

function clientSatisfactionCls(s: string | null) {
  switch (s) {
    case "happy":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "neutral":  return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    case "critical": return "bg-red-500/15 text-red-400 border-red-500/25";
    default:         return "bg-white/5 text-muted-foreground border-white/10";
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
  if (!value) {
    return <span className="text-muted-foreground/40 text-xs">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium",
        cls(value),
      )}
    >
      {labels[value] ?? value}
    </span>
  );
}

// ─── Budget column ─────────────────────────────────────────────────────────────

function BudgetCell({ budgetTotal, budgetConsumed }: { budgetTotal: number | null; budgetConsumed: number | null }) {
  if (!budgetTotal || budgetTotal === 0) {
    return <span className="text-muted-foreground/40 text-xs">—</span>;
  }
  const consumed = budgetConsumed ?? 0;
  const pct = Math.round((consumed / budgetTotal) * 100);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-green-500";
  const textColor = pct >= 90 ? "text-red-400" : pct >= 75 ? "text-amber-400" : "text-green-400";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden min-w-[48px]">
        <div
          className={cn("h-full rounded-full", barColor)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={cn("text-xs font-medium tabular-nums", textColor)}>{pct}%</span>
    </div>
  );
}

// ─── Row tint ──────────────────────────────────────────────────────────────────

function rowTint(riskLevel: string | null) {
  if (riskLevel === "high")   return "bg-red-500/5 hover:bg-red-500/8";
  if (riskLevel === "medium") return "bg-amber-500/5 hover:bg-amber-500/8";
  return "hover:bg-white/4";
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatus() {
  const [, navigate] = useLocation();

  const [search, setSearch]             = useState("");
  const [clientFilter, setClientFilter] = useState("__all__");
  const [pmFilter, setPmFilter]         = useState("__all__");
  const [completedOpen, setCompletedOpen] = useState(false);

  const { data, isLoading } = useQuery<ProjectStatusRow[]>({
    queryKey: ["project-status"],
    queryFn: async () => {
      const res = await fetch("/api/project-status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load project status");
      return res.json();
    },
  });

  const rows = data ?? [];

  const clientOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.clientName).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [rows]);

  const pmOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.pmName).filter(Boolean) as string[]);
    return Array.from(set).sort();
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
      .filter((r) => r.generalStatus !== "completed")
      .sort((a, b) => {
        const clientCmp = (a.clientName ?? "").localeCompare(b.clientName ?? "");
        if (clientCmp !== 0) return clientCmp;
        const riskA = RISK_ORDER[a.riskLevel ?? ""] ?? 3;
        const riskB = RISK_ORDER[b.riskLevel ?? ""] ?? 3;
        return riskA - riskB;
      });
  }, [filtered]);

  const completedRows = useMemo(() => {
    return filtered.filter((r) => r.generalStatus === "completed");
  }, [filtered]);

  const colSpan = 9;

  const tableHeader = (
    <TableHeader>
      <TableRow className="border-white/8 hover:bg-transparent">
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Project</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Customer</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">PM</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">General Status</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Risk Level</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Satisfaction</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Budget</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Updated</TableHead>
        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide max-w-52">Last Comment</TableHead>
      </TableRow>
    </TableHeader>
  );

  function ProjectRow({ row }: { row: ProjectStatusRow }) {
    return (
      <TableRow
        key={row.id}
        className={cn("border-white/8 cursor-pointer transition-colors", rowTint(row.riskLevel))}
        onClick={() => navigate(`/project-status/${row.id}`)}
      >
        <TableCell className="font-medium text-sm">{row.name}</TableCell>
        <TableCell className="text-sm text-muted-foreground">{row.clientName ?? "—"}</TableCell>
        <TableCell className="text-sm text-muted-foreground">{row.pmName ?? "—"}</TableCell>
        <TableCell>
          <StatusBadge value={row.generalStatus} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} />
        </TableCell>
        <TableCell>
          <StatusBadge value={row.riskLevel} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} />
        </TableCell>
        <TableCell>
          <StatusBadge value={row.clientSatisfaction} labels={CLIENT_SATISFACTION_LABELS} cls={clientSatisfactionCls} />
        </TableCell>
        <TableCell>
          <BudgetCell budgetTotal={row.budgetTotal} budgetConsumed={row.budgetConsumed} />
        </TableCell>
        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
          {row.latestUpdateAt
            ? format(new Date(row.latestUpdateAt), "dd MMM yyyy")
            : "—"}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-52">
          {row.latestComment ? (
            <span className="truncate block max-w-52" title={row.latestComment}>
              {row.latestComment}
            </span>
          ) : (
            "—"
          )}
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

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <Input
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-56"
        />

        <Select value={clientFilter} onValueChange={setClientFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All customers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All customers</SelectItem>
            {clientOptions.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={pmFilter} onValueChange={setPmFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All PMs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All PMs</SelectItem>
            {pmOptions.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Active projects table */}
      <div className="rounded-xl border border-white/8 overflow-hidden mb-4">
        <Table>
          {tableHeader}
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-12 text-sm">
                  Loading…
                </TableCell>
              </TableRow>
            ) : activeRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-12 text-sm">
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
              Show {completedRows.length} completed project{completedRows.length !== 1 ? "s" : ""}
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
          {activeRows.length} active{completedRows.length > 0 ? `, ${completedRows.length} completed` : ""}
          {filtered.length !== rows.length ? ` (filtered from ${rows.length} total)` : ""}
        </p>
      )}
    </AdminLayout>
  );
}
