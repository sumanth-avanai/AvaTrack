import { useState, useMemo, useEffect } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  format,
  startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter,
  subMonths, subQuarters,
} from "date-fns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useListProjects } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, ChevronDown, ChevronRight, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type BillingPreset = "this_month" | "last_month" | "this_quarter" | "last_quarter" | "all_time" | "custom";

const PRESET_LABELS: Record<BillingPreset, string> = {
  this_month:   "This Month",
  last_month:   "Last Month",
  this_quarter: "This Quarter",
  last_quarter: "Last Quarter",
  all_time:     "All Time",
  custom:       "Custom range…",
};

interface BillingEmployee {
  id: number;
  name: string;
  loggedHours: number;
  logged: number;
  invoicedHours: number;
  invoiced: number;
  unbilled: number;
}

interface BillingRole {
  id: number;
  name: string;
  dayrate: number;
  budgetedDays: number | null;
  budget: number | null;
  loggedHours: number;
  logged: number;
  invoicedHours: number;
  invoiced: number;
  unbilled: number;
  remaining: number | null;
  employees: BillingEmployee[];
}

interface BillingResponse {
  project: { id: number; name: string };
  totals: { budget: number; logged: number; invoiced: number; unbilled: number; remaining: number };
  roles: BillingRole[];
}

type FilterMode = "all" | "unbilled" | "invoiced";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computePeriod(
  preset: BillingPreset,
  customStart: string,
  customEnd: string,
): { startDate: string | null; endDate: string | null } {
  const today = new Date();
  switch (preset) {
    case "this_month":
      return { startDate: format(startOfMonth(today), "yyyy-MM-dd"), endDate: format(endOfMonth(today), "yyyy-MM-dd") };
    case "last_month": {
      const d = subMonths(today, 1);
      return { startDate: format(startOfMonth(d), "yyyy-MM-dd"), endDate: format(endOfMonth(d), "yyyy-MM-dd") };
    }
    case "this_quarter":
      return { startDate: format(startOfQuarter(today), "yyyy-MM-dd"), endDate: format(endOfQuarter(today), "yyyy-MM-dd") };
    case "last_quarter": {
      const d = subQuarters(today, 1);
      return { startDate: format(startOfQuarter(d), "yyyy-MM-dd"), endDate: format(endOfQuarter(d), "yyyy-MM-dd") };
    }
    case "all_time":
      return { startDate: null, endDate: null };
    case "custom":
      return { startDate: customStart || null, endDate: customEnd || null };
  }
}

function getPeriodLabel(preset: BillingPreset, customStart: string, customEnd: string): string {
  const today = new Date();
  switch (preset) {
    case "this_month":   return format(today, "MMMM yyyy");
    case "last_month":   return format(subMonths(today, 1), "MMMM yyyy");
    case "this_quarter": {
      const q = Math.ceil((today.getMonth() + 1) / 3);
      return `Q${q} ${today.getFullYear()}`;
    }
    case "last_quarter": {
      const d = subQuarters(today, 1);
      const q = Math.ceil((d.getMonth() + 1) / 3);
      return `Q${q} ${d.getFullYear()}`;
    }
    case "all_time": return "All Time";
    case "custom":   return customStart && customEnd ? `${customStart} – ${customEnd}` : "Custom";
  }
}

function eur(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function eurDayRate(n: number): string {
  return `${eur(n)}/d`;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-5 py-4 flex flex-col gap-1 min-w-0">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={cn("text-2xl font-bold tabular-nums", accent ?? "text-foreground")}>{value}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Billing() {
  const today = new Date();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [projectId, setProjectId] = useState<number | null>(null);
  const [preset, setPreset] = useState<BillingPreset>("this_month");
  const [customStart, setCustomStart] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [customEnd,   setCustomEnd]   = useState(format(endOfMonth(today), "yyyy-MM-dd"));
  const [filter, setFilter]           = useState<FilterMode>("all");
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(new Set());
  const [initialised, setInitialised] = useState(false);
  const [showModal, setShowModal]     = useState(false);
  const [invoiceRef, setInvoiceRef]   = useState("");

  const { startDate, endDate } = useMemo(
    () => computePeriod(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  const { data: projects } = useListProjects();

  const billingQuery = useQuery<BillingResponse>({
    queryKey: ["billing", projectId, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate)   params.set("endDate", endDate);
      const res = await fetch(`/api/projects/${projectId}/billing?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load billing data");
      return res.json();
    },
    enabled: projectId != null,
  });

  const data = billingQuery.data;

  // Auto-expand roles with unbilled hours after each load
  useEffect(() => {
    if (data && !initialised) {
      setExpandedRoles(new Set(data.roles.filter((r) => r.unbilled > 0).map((r) => r.id)));
      setInitialised(true);
    }
  }, [data, initialised]);

  // Reset expansion state when project / period changes
  useEffect(() => { setInitialised(false); }, [projectId, startDate, endDate]);

  const markInvoicedMutation = useMutation({
    mutationFn: async (reference: string) => {
      const body: Record<string, unknown> = { projectId };
      if (startDate) body.startDate = startDate;
      if (endDate)   body.endDate   = endDate;
      if (reference) body.invoiceReference = reference;
      const res = await fetch("/api/time-entries/mark-invoiced", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to mark as invoiced");
      return res.json() as Promise<{ updatedCount: number }>;
    },
    onSuccess: ({ updatedCount }) => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      setShowModal(false);
      setInvoiceRef("");
      toast({ title: `${updatedCount} entr${updatedCount === 1 ? "y" : "ies"} marked as invoiced` });
    },
    onError: () => toast({ title: "Failed to mark as invoiced", variant: "destructive" }),
  });

  // ── Filtered roles ──────────────────────────────────────────────────────────

  const filteredRoles = useMemo<BillingRole[]>(() => {
    if (!data) return [];
    return data.roles.filter((r) => {
      if (filter === "unbilled") return r.unbilled > 0;
      if (filter === "invoiced") return r.invoiced > 0;
      return true;
    });
  }, [data, filter]);

  // ── CSV export ──────────────────────────────────────────────────────────────

  function exportCSV() {
    if (!data) return;
    const rows: string[] = ["Role,Employee,Dayrate,Days Logged,Logged,Invoiced,Unbilled,Remaining"];

    for (const role of data.roles) {
      const daysLogged = (role.loggedHours / 8).toFixed(2);
      rows.push([
        `"${role.name}"`,
        "",
        eur(role.dayrate),
        daysLogged,
        eur(role.logged),
        eur(role.invoiced),
        eur(role.unbilled),
        eur(role.remaining),
      ].join(","));
      for (const emp of role.employees) {
        const empDays = (emp.loggedHours / 8).toFixed(2);
        rows.push([
          `"${role.name}"`,
          `"${emp.name}"`,
          eur(role.dayrate),
          empDays,
          eur(emp.logged),
          eur(emp.invoiced),
          eur(emp.unbilled),
          "",
        ].join(","));
      }
    }

    const totalDays = (data.totals.logged / (data.roles[0]?.dayrate ?? 8) * 8 / 8).toFixed(2);
    rows.push([
      "TOTAL",
      "",
      "",
      totalDays,
      eur(data.totals.logged),
      eur(data.totals.invoiced),
      eur(data.totals.unbilled),
      eur(data.totals.remaining),
    ].join(","));

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-${projectId}-${startDate ?? "all"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Remaining colour ────────────────────────────────────────────────────────

  function remainingColour(remaining: number | null, budget: number | null): string {
    if (remaining == null || budget == null || budget === 0) return "text-foreground";
    const pct = remaining / budget;
    if (pct > 0.2)  return "text-green-400";
    if (pct > 0.05) return "text-yellow-400";
    return "text-red-400";
  }

  function unbilledColour(unbilled: number): string {
    return unbilled > 0 ? "text-yellow-400" : "text-green-400";
  }

  // ── Totals remaining colour ─────────────────────────────────────────────────

  const totalsRemainingColour = data
    ? remainingColour(data.totals.remaining, data.totals.budget)
    : "text-foreground";

  const showMarkButton = data && data.totals.unbilled > 0 && (filter === "all" || filter === "unbilled");

  // ── Period label ─────────────────────────────────────────────────────────────

  const periodLabel = getPeriodLabel(preset, customStart, customEnd);

  return (
    <AdminLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-xl font-semibold">Billing</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!data}
          onClick={exportCSV}
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Selectors */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Project</Label>
          <Select
            value={projectId != null ? String(projectId) : ""}
            onValueChange={(v) => setProjectId(Number(v))}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a project…" />
            </SelectTrigger>
            <SelectContent>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Period</Label>
          <Select value={preset} onValueChange={(v) => setPreset(v as BillingPreset)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as BillingPreset[]).map((k) => (
                <SelectItem key={k} value={k}>{PRESET_LABELS[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {preset === "custom" && (
          <>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                className="w-40"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                className="w-40"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      {/* No project selected */}
      {!projectId && (
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-2">
          <Receipt className="h-10 w-10 opacity-30" strokeWidth={1} />
          <p className="text-sm">Select a project to view billing</p>
        </div>
      )}

      {/* Loading */}
      {projectId && billingQuery.isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      )}

      {/* Error */}
      {projectId && billingQuery.isError && (
        <div className="text-sm text-destructive py-12 text-center">Failed to load billing data.</div>
      )}

      {/* Content */}
      {data && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            <KpiCard label="Budget"    value={eur(data.totals.budget)} />
            <KpiCard label="Logged"    value={eur(data.totals.logged)} />
            <KpiCard label="Invoiced"  value={eur(data.totals.invoiced)} />
            <KpiCard
              label="Unbilled"
              value={eur(data.totals.unbilled)}
              accent={unbilledColour(data.totals.unbilled)}
            />
            <KpiCard
              label="Remaining"
              value={eur(data.totals.remaining)}
              accent={totalsRemainingColour}
            />
          </div>

          {/* Toolbar: filter + mark-invoiced */}
          <div className="flex items-center justify-between mb-3">
            <Select value={filter} onValueChange={(v) => setFilter(v as FilterMode)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="unbilled">Unbilled only</SelectItem>
                <SelectItem value="invoiced">Invoiced only</SelectItem>
              </SelectContent>
            </Select>

            {showMarkButton && (
              <Button size="sm" onClick={() => setShowModal(true)}>
                Mark all as invoiced
              </Button>
            )}
          </div>

          {/* Table */}
          {data.roles.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">
              No roles defined for this project.
            </div>
          ) : (
            <div className="rounded-xl border border-white/8 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/8 hover:bg-transparent">
                    <TableHead className="w-full">Role / Employee</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Invoiced</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRoles.map((role) => {
                    const expanded = expandedRoles.has(role.id);
                    const toggle = () =>
                      setExpandedRoles((prev) => {
                        const next = new Set(prev);
                        if (next.has(role.id)) next.delete(role.id); else next.add(role.id);
                        return next;
                      });

                    return [
                      // Role row
                      <TableRow
                        key={`role-${role.id}`}
                        className="border-white/8 cursor-pointer hover:bg-white/3 font-medium"
                        onClick={toggle}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {expanded
                              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            }
                            <span>{role.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                          {eurDayRate(role.dayrate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(role.invoiced)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                          {eur(role.unbilled)}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums", remainingColour(role.remaining, role.budget))}>
                          {role.remaining != null ? eur(role.remaining) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      </TableRow>,

                      // Employee rows (collapsed by default unless unbilled > 0)
                      ...(!expanded ? [] : role.employees.map((emp) => (
                        <TableRow
                          key={`emp-${role.id}-${emp.id}`}
                          className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                        >
                          <TableCell>
                            <span className="ml-6 text-foreground/70">{emp.name}</span>
                          </TableCell>
                          <TableCell />
                          <TableCell />
                          <TableCell className="text-right tabular-nums">{eur(emp.logged)}</TableCell>
                          <TableCell className="text-right tabular-nums">{eur(emp.invoiced)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                            {eur(emp.unbilled)}
                          </TableCell>
                          <TableCell />
                        </TableRow>
                      ))),
                    ];
                  })}

                  {/* Totals row */}
                  <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
                    <TableCell>Total</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{eur(data.totals.budget)}</TableCell>
                    <TableCell className="text-right tabular-nums">{eur(data.totals.logged)}</TableCell>
                    <TableCell className="text-right tabular-nums">{eur(data.totals.invoiced)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", unbilledColour(data.totals.unbilled))}>
                      {eur(data.totals.unbilled)}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", totalsRemainingColour)}>
                      {eur(data.totals.remaining)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {/* Mark as invoiced modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as invoiced</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Project</span>
              <span className="font-medium">{data?.project.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Period</span>
              <span className="font-medium">{periodLabel}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount (unbilled)</span>
              <span className="font-semibold text-yellow-400">{eur(data?.totals.unbilled ?? 0)}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-ref">Invoice reference (optional)</Label>
            <Input
              id="invoice-ref"
              placeholder={`INV-${format(today, "yyyy-MM")}-${data?.project.name.slice(0, 6).toUpperCase() ?? ""}`}
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowModal(false); setInvoiceRef(""); }}>
              Cancel
            </Button>
            <Button
              onClick={() => markInvoicedMutation.mutate(invoiceRef)}
              disabled={markInvoicedMutation.isPending}
            >
              {markInvoicedMutation.isPending ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
