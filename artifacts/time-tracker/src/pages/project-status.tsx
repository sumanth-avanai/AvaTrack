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
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectStatusRow {
  id: number;
  name: string;
  clientName: string | null;
  pmName: string | null;
  generalStatus: string | null;
  budgetStatus: string | null;
  riskLevel: string | null;
  latestUpdateAt: string | null;
  latestComment: string | null;
}

// ─── Label maps ───────────────────────────────────────────────────────────────

const GENERAL_STATUS_LABELS: Record<string, string> = {
  planned:     "Planned",
  in_progress: "In Progress",
  on_hold:     "On Hold",
  completed:   "Completed",
  cancelled:   "Cancelled",
};

const BUDGET_STATUS_LABELS: Record<string, string> = {
  on_track:    "On Track",
  at_risk:     "At Risk",
  over_budget: "Over Budget",
  completed:   "Completed",
};

const RISK_LEVEL_LABELS: Record<string, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
};

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

function budgetStatusCls(s: string | null) {
  switch (s) {
    case "on_track":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "at_risk":     return "bg-yellow-500/15 text-yellow-400 border-yellow-500/25";
    case "over_budget": return "bg-red-500/15 text-red-400 border-red-500/25";
    case "completed":   return "bg-gray-500/15 text-gray-400 border-gray-500/25";
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatus() {
  const [, navigate] = useLocation();

  const [search, setSearch]         = useState("");
  const [clientFilter, setClientFilter] = useState("__all__");
  const [pmFilter, setPmFilter]         = useState("__all__");

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

      {/* Table */}
      <div className="rounded-xl border border-white/8 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-white/8 hover:bg-transparent">
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Project</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Customer</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">PM</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">General Status</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Budget Status</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Risk Level</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Updated</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide max-w-52">Last Comment</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-12 text-sm">
                  Loading…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-12 text-sm">
                  {rows.length === 0 ? "No active projects found." : "No projects match your filters."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <TableRow
                  key={row.id}
                  className="border-white/8 cursor-pointer hover:bg-white/4 transition-colors"
                  onClick={() => navigate(`/project-status/${row.id}`)}
                >
                  <TableCell className="font-medium text-sm">{row.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.clientName ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.pmName ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge value={row.generalStatus} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.budgetStatus} labels={BUDGET_STATUS_LABELS} cls={budgetStatusCls} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.riskLevel} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} />
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
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          {filtered.length} project{filtered.length !== 1 ? "s" : ""}
          {filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ""}
        </p>
      )}
    </AdminLayout>
  );
}
