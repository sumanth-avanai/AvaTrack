import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Activity,
  Plus,
  ExternalLink,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectDetail {
  id: number;
  name: string;
  clientId: number;
  clientName: string | null;
  pmName: string | null;
  generalStatus: string | null;
  riskLevel: string | null;
  clientSatisfaction: string | null;
  budgetTotal: number | null;
  budgetConsumed: number | null;
}

interface HealthUpdate {
  id: number;
  projectId: number;
  generalStatus: string;
  budgetStatus: string | null;
  riskLevel: string;
  clientSatisfaction: string | null;
  comment: string | null;
  createdAt: string;
}

interface ProjectStatusDetailResponse {
  project: ProjectDetail;
  history: HealthUpdate[];
}

// ─── Label maps ───────────────────────────────────────────────────────────────

const GENERAL_STATUS_OPTIONS = [
  { value: "planned",     label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "on_hold",     label: "On Hold" },
  { value: "completed",   label: "Completed" },
  { value: "cancelled",   label: "Cancelled" },
];

const BUDGET_STATUS_LABELS: Record<string, string> = {
  on_track:    "On Track",
  at_risk:     "At Risk",
  over_budget: "Over Budget",
  completed:   "Completed",
};

const RISK_LEVEL_OPTIONS = [
  { value: "low",    label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
];

const CLIENT_SATISFACTION_OPTIONS = [
  { value: "happy",    label: "Happy" },
  { value: "neutral",  label: "Neutral" },
  { value: "critical", label: "Critical" },
];

const GENERAL_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  GENERAL_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);
const RISK_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  RISK_LEVEL_OPTIONS.map((o) => [o.value, o.label]),
);
const CLIENT_SATISFACTION_LABELS: Record<string, string> = Object.fromEntries(
  CLIENT_SATISFACTION_OPTIONS.map((o) => [o.value, o.label]),
);

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
  size = "sm",
}: {
  value: string | null;
  labels: Record<string, string>;
  cls: (v: string | null) => string;
  size?: "sm" | "lg";
}) {
  if (!value) {
    return <span className="text-muted-foreground/40 text-xs">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium",
        size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
        cls(value),
      )}
    >
      {labels[value] ?? value}
    </span>
  );
}

// ─── Budget display ────────────────────────────────────────────────────────────

function BudgetBar({ budgetTotal, budgetConsumed }: { budgetTotal: number | null; budgetConsumed: number | null }) {
  if (!budgetTotal || budgetTotal === 0) return null;
  const consumed = budgetConsumed ?? 0;
  const pct = Math.round((consumed / budgetTotal) * 100);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-green-500";
  const textColor = pct >= 90 ? "text-red-400" : pct >= 75 ? "text-amber-400" : "text-green-400";

  const fmt = (n: number) => {
    if (n >= 1000) return `€${Math.round(n / 1000)}k`;
    return `€${Math.round(n)}`;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 bg-white/8 rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <span className={cn("text-sm font-semibold tabular-nums", textColor)}>{pct}%</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {fmt(consumed)} of {fmt(budgetTotal)} consumed ({pct}%)
      </p>
    </div>
  );
}

// ─── History entry ────────────────────────────────────────────────────────────

function HistoryEntry({ entry }: { entry: HealthUpdate }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="h-2 w-2 rounded-full bg-white/20 mt-1.5 shrink-0" />
        <div className="w-px flex-1 bg-white/8 mt-1" />
      </div>
      <div className="pb-6 min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" strokeWidth={1.5} />
          <span className="text-xs text-muted-foreground">
            {format(new Date(entry.createdAt), "dd MMM yyyy, HH:mm")}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          <StatusBadge value={entry.generalStatus} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} />
          {entry.budgetStatus && (
            <StatusBadge value={entry.budgetStatus} labels={BUDGET_STATUS_LABELS} cls={budgetStatusCls} />
          )}
          <StatusBadge value={entry.riskLevel} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} />
          {entry.clientSatisfaction && (
            <StatusBadge value={entry.clientSatisfaction} labels={CLIENT_SATISFACTION_LABELS} cls={clientSatisfactionCls} />
          )}
        </div>
        {entry.comment && (
          <p className="text-sm text-foreground/80 whitespace-pre-wrap">{entry.comment}</p>
        )}
      </div>
    </div>
  );
}

// ─── Add Update Dialog ────────────────────────────────────────────────────────

interface AddUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  defaults: { generalStatus: string; riskLevel: string; clientSatisfaction: string };
  onSuccess: () => void;
}

function AddUpdateDialog({ open, onClose, projectId, defaults, onSuccess }: AddUpdateDialogProps) {
  const { toast } = useToast();
  const [generalStatus,      setGeneralStatus]      = useState(defaults.generalStatus);
  const [riskLevel,          setRiskLevel]          = useState(defaults.riskLevel);
  const [clientSatisfaction, setClientSatisfaction] = useState(defaults.clientSatisfaction);
  const [comment,            setComment]            = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/project-status/${projectId}/health-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          generalStatus,
          riskLevel,
          clientSatisfaction: clientSatisfaction && clientSatisfaction !== "__none__" ? clientSatisfaction : undefined,
          comment: comment || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status update saved" });
      setComment("");
      onSuccess();
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  function handleOpenChange(v: boolean) {
    if (!v) onClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Status Update</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">General Status</Label>
            <Select value={generalStatus} onValueChange={setGeneralStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERAL_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Risk Level</Label>
            <Select value={riskLevel} onValueChange={setRiskLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RISK_LEVEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Client Satisfaction <span className="text-muted-foreground/50">(optional)</span></Label>
            <Select value={clientSatisfaction} onValueChange={setClientSatisfaction}>
              <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not set</SelectItem>
                {CLIENT_SATISFACTION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Comment <span className="text-muted-foreground/50">(optional)</span></Label>
            <Textarea
              rows={3}
              placeholder="Any notes about the current status…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatusDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const projectId = Number(id);

  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<ProjectStatusDetailResponse>({
    queryKey: ["project-status-detail", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/project-status/${projectId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load project");
      return res.json();
    },
    enabled: !isNaN(projectId),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["project-status-detail", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project-status"] });
  }

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading…</div>
      </AdminLayout>
    );
  }

  if (isError || !data) {
    return (
      <AdminLayout>
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <p className="text-muted-foreground text-sm">Project not found.</p>
          <Button variant="outline" size="sm" onClick={() => navigate("/project-status")}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to overview
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const { project, history } = data;

  const latestEntry = history[0] ?? null;

  const dialogDefaults = {
    generalStatus:      project.generalStatus      ?? "in_progress",
    riskLevel:          project.riskLevel          ?? "low",
    clientSatisfaction: project.clientSatisfaction ?? "__none__",
  };

  return (
    <AdminLayout>
      {/* Back */}
      <button
        onClick={() => navigate("/project-status")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Project Status
      </button>

      {/* Project header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
            <h1 className="text-xl font-semibold">{project.name}</h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
            {project.clientName && <span>{project.clientName}</span>}
            {project.clientName && project.pmName && <span className="text-white/15">·</span>}
            {project.pmName && <span>PM: {project.pmName}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/billing?project=${project.id}`)}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open in Billing
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/reports`)}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open in Reports
          </Button>
        </div>
      </div>

      {/* Current health card */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide">Current Health</h2>
          <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add Update
          </Button>
        </div>

        {project.generalStatus || project.riskLevel ? (
          <>
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">General</span>
                <StatusBadge value={project.generalStatus} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} size="lg" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Risk</span>
                <StatusBadge value={project.riskLevel} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} size="lg" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Satisfaction</span>
                <StatusBadge value={project.clientSatisfaction} labels={CLIENT_SATISFACTION_LABELS} cls={clientSatisfactionCls} size="lg" />
              </div>
            </div>

            {/* Budget computed display */}
            {project.budgetTotal && project.budgetTotal > 0 && (
              <div className="border-t border-white/8 pt-4 mt-2 mb-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wide block mb-2">Budget Consumption</span>
                <BudgetBar budgetTotal={project.budgetTotal} budgetConsumed={project.budgetConsumed} />
              </div>
            )}

            {latestEntry?.comment && (
              <p className="text-sm text-foreground/70 whitespace-pre-wrap border-t border-white/8 pt-4 mt-4">
                {latestEntry.comment}
              </p>
            )}

            {latestEntry && (
              <p className="text-xs text-muted-foreground/50 mt-3">
                Last updated {format(new Date(latestEntry.createdAt), "dd MMM yyyy, HH:mm")}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
            <p className="text-sm text-muted-foreground">No status set yet.</p>
            <p className="text-xs text-muted-foreground/60">Click "Add Update" to record the first health check.</p>
          </div>
        )}
      </div>

      {/* History */}
      <h2 className="text-sm font-semibold text-foreground/80 uppercase tracking-wide mb-4">History</h2>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">No updates recorded yet.</p>
      ) : (
        <div>
          {history.map((entry) => (
            <HistoryEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {/* Add Update Dialog */}
      {dialogOpen && (
        <AddUpdateDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          projectId={projectId}
          defaults={dialogDefaults}
          onSuccess={invalidate}
        />
      )}
    </AdminLayout>
  );
}
