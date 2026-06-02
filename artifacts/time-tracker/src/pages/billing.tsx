import { useState, useMemo, useEffect, useCallback } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, ChevronDown, ChevronRight, Receipt, X, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type BillingPreset = "this_month" | "last_month" | "this_quarter" | "last_quarter" | "all_time" | "custom";
type FilterMode    = "all" | "unbilled" | "invoiced" | "invest";
type BillingStatusVal = "invoiced" | "invest" | null;

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
  investHours: number;
  invest: number;
  unbilled: number;
  billingStatus: BillingStatusVal;
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
  investHours: number;
  invest: number;
  unbilled: number;
  remaining: number | null;
  employees: BillingEmployee[];
}

interface BillingTotals {
  budget: number;
  logged: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  remaining: number;
}

interface BillingResponse {
  project: { id: number; name: string };
  totals: BillingTotals;
  roles: BillingRole[];
}

// All-projects types
interface AllBillingEmployee {
  id: number;
  name: string;
  hours: number;
  days: number;
  revenue: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  billingStatus: BillingStatusVal;
}

interface AllBillingRole {
  id: number;
  name: string;
  dayrate: number;
  budgetedDays: number | null;
  budget: number | null;
  loggedDays: number;
  loggedHours: number;
  logged: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  remaining: number | null;
  employees: AllBillingEmployee[];
}

interface AllBillingProject {
  id: number;
  name: string;
  totals: BillingTotals;
  roles: AllBillingRole[];
}

interface AllBillingClient {
  id: number;
  name: string;
  totals: BillingTotals;
  projects: AllBillingProject[];
}

interface AllBillingResponse {
  totals: BillingTotals;
  clients: AllBillingClient[];
}

interface HistoryEntry {
  reference: string | null;
  invoicedAt: string;
  totalAmount: number;
  roleCount: number;
  employeeCount: number;
  roles: { id: number; name: string }[];
  employees: { id: number; name: string }[];
}

interface HistoryResponse {
  project: { id: number; name: string };
  history: HistoryEntry[];
}

// ─── Selection helpers ────────────────────────────────────────────────────────

function empKey(roleId: number, employeeId: number): string {
  return `r${roleId}-e${employeeId}`;
}

function parseSelection(sel: Set<string>): { roleId: number; employeeId: number }[] {
  return Array.from(sel).map((key) => {
    const m = key.match(/^r(\d+)-e(\d+)$/);
    if (!m) throw new Error(`Invalid key: ${key}`);
    return { roleId: Number(m[1]), employeeId: Number(m[2]) };
  });
}

// ─── Period helpers ───────────────────────────────────────────────────────────

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
    case "all_time": return { startDate: null, endDate: null };
    case "custom":   return { startDate: customStart || null, endDate: customEnd || null };
  }
}

function getPeriodLabel(preset: BillingPreset, customStart: string, customEnd: string): string {
  const today = new Date();
  switch (preset) {
    case "this_month":   return format(today, "MMMM yyyy");
    case "last_month":   return format(subMonths(today, 1), "MMMM yyyy");
    case "this_quarter": return `Q${Math.ceil((today.getMonth() + 1) / 3)} ${today.getFullYear()}`;
    case "last_quarter": {
      const d = subQuarters(today, 1);
      return `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`;
    }
    case "all_time": return "All Time";
    case "custom":   return customStart && customEnd ? `${customStart} – ${customEnd}` : "Custom";
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function eur(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function eurDayRate(n: number): string {
  return `${eur(n)}/d`;
}

function fmtDays(n: number): string {
  return n.toFixed(2);
}

function fmtHours(n: number): string {
  return n.toFixed(2);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, accent, subLabel }: { label: string; value: string; accent?: string; subLabel?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-5 py-4 flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={cn("text-2xl font-bold tabular-nums", accent ?? "text-foreground")}>{value}</span>
      {subLabel && <span className="text-xs text-muted-foreground">{subLabel}</span>}
    </div>
  );
}

function StatusBadge({ status }: { status: BillingStatusVal }) {
  if (!status) return <span className="text-muted-foreground/50 text-sm">—</span>;
  if (status === "invoiced") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400 shrink-0" />
        Invoiced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-400">
      <span className="h-1.5 w-1.5 rounded-full bg-purple-400 shrink-0" />
      Invest
    </span>
  );
}

// ─── All Projects Table ───────────────────────────────────────────────────────

function AllProjectsTable({ allData }: { allData: AllBillingResponse }) {
  const [expandedClients,  setExpandedClients]  = useState<Set<number>>(() => new Set(allData.clients.map((c) => c.id)));
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(() =>
    new Set(allData.clients.flatMap((c) => c.projects.filter((p) => p.totals.unbilled > 0).map((p) => p.id))),
  );
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(() =>
    new Set(allData.clients.flatMap((c) => c.projects.flatMap((p) => p.roles.filter((r) => r.unbilled > 0).map((r) => r.id)))),
  );

  const toggleClient  = (id: number) => setExpandedClients((p)  => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleProject = (id: number) => setExpandedProjects((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleRole    = (id: number) => setExpandedRoles((p)    => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  function unbilledColour(unbilled: number): string {
    return unbilled > 0 ? "text-yellow-400" : "text-green-400";
  }

  const hasAnyData = allData.clients.some((c) => c.projects.some((p) => p.roles.length > 0));

  if (!hasAnyData) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        No roles or time entries found for this period.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/8 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-white/8 hover:bg-transparent">
            <TableHead className="w-full">Client / Project / Role / Employee</TableHead>
            <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
            <TableHead className="text-right whitespace-nowrap">Days</TableHead>
            <TableHead className="text-right whitespace-nowrap">Hours</TableHead>
            <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
            <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
            <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allData.clients.map((client) => {
            if (client.projects.length === 0) return null;
            const clientExpanded = expandedClients.has(client.id);

            return [
              // Client row
              <TableRow
                key={`client-${client.id}`}
                className="border-white/8 cursor-pointer hover:bg-white/3 font-semibold bg-white/2"
                onClick={() => toggleClient(client.id)}
              >
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {clientExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    }
                    <span className="text-sm">{client.name}</span>
                  </div>
                </TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {fmtDays(client.totals.logged > 0 ? client.projects.flatMap((p) => p.roles).reduce((s, r) => s + r.loggedDays, 0) : 0)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {fmtHours(client.projects.flatMap((p) => p.roles).reduce((s, r) => s + r.loggedHours, 0))}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {client.totals.budget > 0 ? eur(client.totals.budget) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{eur(client.totals.logged)}</TableCell>
                <TableCell className={cn("text-right tabular-nums text-sm", unbilledColour(client.totals.unbilled))}>
                  {eur(client.totals.unbilled)}
                </TableCell>
              </TableRow>,

              ...(!clientExpanded ? [] : client.projects.map((project) => {
                const projectExpanded = expandedProjects.has(project.id);
                const projectDays  = project.roles.reduce((s, r) => s + r.loggedDays,  0);
                const projectHours = project.roles.reduce((s, r) => s + r.loggedHours, 0);

                return [
                  // Project row
                  <TableRow
                    key={`project-${project.id}`}
                    className="border-white/8 cursor-pointer hover:bg-white/3 font-medium"
                    onClick={() => toggleProject(project.id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 ml-5">
                        {projectExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        }
                        <span className="text-sm">{project.name}</span>
                      </div>
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtDays(projectDays)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtHours(projectHours)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {project.totals.budget > 0 ? eur(project.totals.budget) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{eur(project.totals.logged)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums text-sm", unbilledColour(project.totals.unbilled))}>
                      {eur(project.totals.unbilled)}
                    </TableCell>
                  </TableRow>,

                  ...(!projectExpanded ? [] : project.roles.map((role) => {
                    const roleExpanded = expandedRoles.has(role.id);

                    return [
                      // Role row
                      <TableRow
                        key={`role-${role.id}`}
                        className="border-white/8 cursor-pointer hover:bg-white/2 text-sm"
                        onClick={() => toggleRole(role.id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5 ml-10">
                            {roleExpanded
                              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            }
                            <span className="text-foreground/80">{role.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground text-xs">{eurDayRate(role.dayrate)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtDays(role.loggedDays)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtHours(role.loggedHours)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                          {eur(role.unbilled)}
                        </TableCell>
                      </TableRow>,

                      ...(!roleExpanded ? [] : role.employees.map((emp) => (
                        <TableRow
                          key={`emp-${role.id}-${emp.id}`}
                          className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                        >
                          <TableCell>
                            <span className="ml-[72px] text-foreground/60">{emp.name}</span>
                          </TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular-nums">{fmtDays(emp.days)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtHours(emp.hours)}</TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular-nums">{eur(emp.revenue)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                            {eur(emp.unbilled)}
                          </TableCell>
                        </TableRow>
                      ))),
                    ];
                  })),
                ];
              })),
            ];
          })}

          {/* Totals row */}
          <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
            <TableCell>Total</TableCell>
            <TableCell />
            <TableCell className="text-right tabular-nums">
              {fmtDays(allData.clients.flatMap((c) => c.projects.flatMap((p) => p.roles)).reduce((s, r) => s + r.loggedDays, 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtHours(allData.clients.flatMap((c) => c.projects.flatMap((p) => p.roles)).reduce((s, r) => s + r.loggedHours, 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums">{eur(allData.totals.budget)}</TableCell>
            <TableCell className="text-right tabular-nums">{eur(allData.totals.logged)}</TableCell>
            <TableCell className={cn("text-right tabular-nums", allData.totals.unbilled > 0 ? "text-yellow-400" : "text-green-400")}>
              {eur(allData.totals.unbilled)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Billing() {
  const today = new Date();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Selectors state ──────────────────────────────────────────────────────────
  // projectId: null = nothing selected, "all" = all projects, number = specific project
  const [projectSel, setProjectSel] = useState<"all" | number | null>(null);
  const [preset, setPreset]         = useState<BillingPreset>("this_month");
  const [customStart, setCustomStart] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [customEnd,   setCustomEnd]   = useState(format(endOfMonth(today), "yyyy-MM-dd"));
  const [filter, setFilter]         = useState<FilterMode>("all");

  const projectId = typeof projectSel === "number" ? projectSel : null;
  const isAllProjects = projectSel === "all";

  // ── Table state ──────────────────────────────────────────────────────────────
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(new Set());
  const [initialised,   setInitialised]   = useState(false);

  // ── Selection state ──────────────────────────────────────────────────────────
  const [selection, setSelection]     = useState<Set<string>>(new Set());

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceRef, setInvoiceRef]             = useState("");

  // ── History panel state ───────────────────────────────────────────────────────
  const [historyOpen,    setHistoryOpen]    = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  const { startDate, endDate } = useMemo(
    () => computePeriod(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  // ── Data ─────────────────────────────────────────────────────────────────────
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

  const allBillingQuery = useQuery<AllBillingResponse>({
    queryKey: ["billing-all", startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate)   params.set("endDate", endDate);
      const res = await fetch(`/api/billing?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load billing data");
      return res.json();
    },
    enabled: isAllProjects,
  });

  const data    = billingQuery.data;
  const allData = allBillingQuery.data;

  const historyQuery = useQuery<HistoryResponse>({
    queryKey: ["billing-history", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/billing/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoice history");
      return res.json();
    },
    enabled: projectId != null,
  });

  // Pre-select project from ?project= query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("project");
    if (pid && !isNaN(Number(pid))) setProjectSel(Number(pid));
  }, []);

  // Auto-expand roles with unbilled hours after each load
  useEffect(() => {
    if (data && !initialised) {
      setExpandedRoles(new Set(data.roles.filter((r) => r.unbilled > 0).map((r) => r.id)));
      setInitialised(true);
    }
  }, [data, initialised]);

  // Clear selection and reset on project/period change
  useEffect(() => {
    setInitialised(false);
    setSelection(new Set());
  }, [projectSel, startDate, endDate]);

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const updateStatusMutation = useMutation({
    mutationFn: async ({ status, invoiceReference }: { status: "invoiced" | "invest"; invoiceReference?: string }) => {
      const items = parseSelection(selection);
      const body: Record<string, unknown> = { projectId, items, status };
      if (startDate)        body.startDate = startDate;
      if (endDate)          body.endDate   = endDate;
      if (invoiceReference) body.invoiceReference = invoiceReference;
      const res = await fetch("/api/time-entries/update-billing-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update billing status");
      return res.json() as Promise<{ updatedCount: number }>;
    },
    onSuccess: ({ updatedCount }, { status }) => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      queryClient.invalidateQueries({ queryKey: ["billing-history"] });
      setSelection(new Set());
      setShowInvoiceModal(false);
      setInvoiceRef("");
      const label = status === "invest" ? "invest" : "invoiced";
      toast({ title: `${updatedCount} entr${updatedCount === 1 ? "y" : "ies"} marked as ${label}` });
    },
    onError: () => toast({ title: "Failed to update billing status", variant: "destructive" }),
  });

  // ── Filtered roles ────────────────────────────────────────────────────────────

  const filteredRoles = useMemo<BillingRole[]>(() => {
    if (!data) return [];
    return data.roles.filter((r) => {
      if (filter === "unbilled") return r.unbilled > 0;
      if (filter === "invoiced") return r.invoiced > 0;
      if (filter === "invest")   return r.invest > 0;
      return true;
    });
  }, [data, filter]);

  // ── Selection helpers ─────────────────────────────────────────────────────────

  const allVisibleKeys = useMemo(
    () => filteredRoles.flatMap((r) => r.employees.map((e) => empKey(r.id, e.id))),
    [filteredRoles],
  );

  const isRoleSelected = useCallback((role: BillingRole) =>
    role.employees.length > 0 && role.employees.every((e) => selection.has(empKey(role.id, e.id))),
  [selection]);

  const isRoleIndeterminate = useCallback((role: BillingRole) => {
    const count = role.employees.filter((e) => selection.has(empKey(role.id, e.id))).length;
    return count > 0 && count < role.employees.length;
  }, [selection]);

  const handleRoleCheck = useCallback((role: BillingRole, checked: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const emp of role.employees) {
        const key = empKey(role.id, emp.id);
        if (checked) next.add(key); else next.delete(key);
      }
      return next;
    });
  }, []);

  const handleEmpCheck = useCallback((roleId: number, empId: number, checked: boolean) => {
    const key = empKey(roleId, empId);
    setSelection((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const allSelected  = allVisibleKeys.length > 0 && allVisibleKeys.every((k) => selection.has(k));
  const someSelected = allVisibleKeys.some((k) => selection.has(k));

  const handleSelectAll = useCallback((checked: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (checked) { allVisibleKeys.forEach((k) => next.add(k)); }
      else         { allVisibleKeys.forEach((k) => next.delete(k)); }
      return next;
    });
  }, [allVisibleKeys]);

  // ── Selected amount ───────────────────────────────────────────────────────────

  const selectedAmount = useMemo(() => {
    if (!data) return 0;
    let total = 0;
    for (const role of data.roles) {
      for (const emp of role.employees) {
        if (selection.has(empKey(role.id, emp.id))) total += emp.unbilled;
      }
    }
    return Math.round(total * 100) / 100;
  }, [data, selection]);

  // ── CSV export ────────────────────────────────────────────────────────────────

  function exportCSV() {
    const periodStr = startDate ?? "all";
    const header = "Client,Project,Role,Employee,Dayrate,Days,Hours,Revenue";

    if (isAllProjects && allData) {
      const rows: string[] = [header];
      for (const client of allData.clients) {
        for (const project of client.projects) {
          for (const role of project.roles) {
            for (const emp of role.employees) {
              rows.push([
                `"${client.name}"`,
                `"${project.name}"`,
                `"${role.name}"`,
                `"${emp.name}"`,
                role.dayrate,
                emp.days.toFixed(2),
                emp.hours.toFixed(2),
                emp.revenue,
              ].join(","));
            }
          }
        }
      }
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `billing-all-${periodStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (data) {
      const projectName = data.project.name.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const rows: string[] = [header];
      for (const role of data.roles) {
        for (const emp of role.employees) {
          const days    = emp.loggedHours / 8;
          const revenue = emp.logged;
          rows.push([
            `"${data.project.name}"`,
            `"${data.project.name}"`,
            `"${role.name}"`,
            `"${emp.name}"`,
            role.dayrate,
            days.toFixed(2),
            emp.loggedHours.toFixed(2),
            revenue,
          ].join(","));
        }
      }
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `billing-${projectName}-${periodStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // ── Colours ───────────────────────────────────────────────────────────────────

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

  const activeTotals = isAllProjects ? allData?.totals : data?.totals;

  const totalsRemainingColour = activeTotals
    ? remainingColour(activeTotals.remaining, activeTotals.budget)
    : "text-foreground";

  const periodLabel = getPeriodLabel(preset, customStart, customEnd);

  const canExport = (isAllProjects && !!allData) || (!isAllProjects && !!data);

  return (
    <AdminLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-xl font-semibold">Billing</h1>
        </div>
        <Button variant="outline" size="sm" disabled={!canExport} onClick={exportCSV} className="gap-2">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Project + Period selectors */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Project</Label>
          <Select
            value={projectSel != null ? String(projectSel) : ""}
            onValueChange={(v) => {
              if (v === "all") setProjectSel("all");
              else setProjectSel(Number(v));
            }}
          >
            <SelectTrigger className="w-64"><SelectValue placeholder="Select a project…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              <div className="my-1 border-t border-white/10" />
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Period</Label>
          <Select value={preset} onValueChange={(v) => setPreset(v as BillingPreset)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
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
              <Input type="date" className="w-40" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" className="w-40" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </div>
          </>
        )}
      </div>

      {/* No project selected */}
      {projectSel == null && (
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-2">
          <Receipt className="h-10 w-10 opacity-30" strokeWidth={1} />
          <p className="text-sm">Select a project to view billing</p>
        </div>
      )}

      {/* Single project loading / error */}
      {!isAllProjects && projectId != null && billingQuery.isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      )}
      {!isAllProjects && projectId != null && billingQuery.isError && (
        <div className="text-sm text-destructive py-12 text-center">Failed to load billing data.</div>
      )}

      {/* All projects loading / error */}
      {isAllProjects && allBillingQuery.isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      )}
      {isAllProjects && allBillingQuery.isError && (
        <div className="text-sm text-destructive py-12 text-center">Failed to load billing data.</div>
      )}

      {/* KPI Cards — shown for both modes */}
      {activeTotals && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            <KpiCard label="Budget"   value={eur(activeTotals.budget)} />
            <KpiCard
              label="Logged"
              value={eur(activeTotals.logged)}
              subLabel={activeTotals.invest > 0 ? `(${eur(activeTotals.invest)} inv)` : undefined}
            />
            <KpiCard label="Invoiced" value={eur(activeTotals.invoiced)} />
            <KpiCard
              label="Unbilled"
              value={eur(activeTotals.unbilled)}
              accent={unbilledColour(activeTotals.unbilled)}
            />
            <KpiCard
              label="Remaining"
              value={eur(activeTotals.remaining)}
              accent={totalsRemainingColour}
            />
          </div>

          {/* All Projects view */}
          {isAllProjects && allData && (
            <AllProjectsTable allData={allData} />
          )}

          {/* Single project view */}
          {!isAllProjects && data && (
            <>
              {/* Toolbar */}
              <div className="flex items-center gap-2 mb-3">
                <Select value={filter} onValueChange={(v) => setFilter(v as FilterMode)}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="unbilled">Unbilled only</SelectItem>
                    <SelectItem value="invoiced">Invoiced only</SelectItem>
                    <SelectItem value="invest">Invest only</SelectItem>
                  </SelectContent>
                </Select>

                {selection.size > 0 && (
                  <span className="text-sm text-muted-foreground">
                    Selected: <span className="text-foreground font-medium">{selection.size}</span>
                    {selectedAmount > 0 && (
                      <span className="text-yellow-400 ml-1">({eur(selectedAmount)})</span>
                    )}
                  </span>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="default" className="gap-1" disabled={selection.size === 0}>
                      Mark as <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setShowInvoiceModal(true)}>
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400 mr-2 shrink-0" />
                      Invoiced
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => updateStatusMutation.mutate({ status: "invest" })}
                      disabled={updateStatusMutation.isPending}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-purple-400 mr-2 shrink-0" />
                      Invest
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {selection.size > 0 && (
                  <Button size="sm" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => setSelection(new Set())}>
                    <X className="h-3.5 w-3.5" />
                    Clear selection
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
                        <TableHead className="w-8 pr-0">
                          <Checkbox
                            checked={someSelected && !allSelected ? "indeterminate" : allSelected}
                            onCheckedChange={(c) => handleSelectAll(!!c)}
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead className="w-full">Role / Employee</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Days</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Hours</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Remaining</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRoles.map((role) => {
                        const expanded    = expandedRoles.has(role.id);
                        const roleChecked = isRoleSelected(role);
                        const roleIndet   = isRoleIndeterminate(role);

                        const toggleExpand = () =>
                          setExpandedRoles((prev) => {
                            const next = new Set(prev);
                            if (next.has(role.id)) next.delete(role.id); else next.add(role.id);
                            return next;
                          });

                        return [
                          <TableRow
                            key={`role-${role.id}`}
                            className="border-white/8 cursor-pointer hover:bg-white/3 font-medium"
                            onClick={toggleExpand}
                          >
                            <TableCell className="pr-0" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={roleIndet ? "indeterminate" : roleChecked}
                                onCheckedChange={(c) => handleRoleCheck(role, !!c)}
                                aria-label={`Select role ${role.name}`}
                              />
                            </TableCell>
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
                            <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                              {fmtDays(role.loggedHours / 8)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                              {fmtHours(role.loggedHours)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                            <TableCell />
                            <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                              {eur(role.unbilled)}
                            </TableCell>
                            <TableCell className={cn("text-right tabular-nums", remainingColour(role.remaining, role.budget))}>
                              {role.remaining != null ? eur(role.remaining) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                          </TableRow>,

                          ...(!expanded ? [] : role.employees.map((emp) => {
                            const empChecked = selection.has(empKey(role.id, emp.id));
                            const empDays    = emp.loggedHours / 8;
                            return (
                              <TableRow
                                key={`emp-${role.id}-${emp.id}`}
                                className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                              >
                                <TableCell className="pr-0">
                                  <Checkbox
                                    checked={empChecked}
                                    onCheckedChange={(c) => handleEmpCheck(role.id, emp.id, !!c)}
                                    aria-label={`Select ${emp.name}`}
                                  />
                                </TableCell>
                                <TableCell>
                                  <span className="ml-6 text-foreground/70">{emp.name}</span>
                                </TableCell>
                                <TableCell />
                                <TableCell className="text-right tabular-nums">{fmtDays(empDays)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtHours(emp.loggedHours)}</TableCell>
                                <TableCell />
                                <TableCell className="text-right tabular-nums">{eur(emp.logged)}</TableCell>
                                <TableCell><StatusBadge status={emp.billingStatus} /></TableCell>
                                <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                                  {eur(emp.unbilled)}
                                </TableCell>
                                <TableCell />
                              </TableRow>
                            );
                          })),
                        ];
                      })}

                      {/* Totals row */}
                      <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
                        <TableCell />
                        <TableCell>Total</TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                          {fmtDays(data.totals.logged > 0 ? data.roles.reduce((s, r) => s + r.loggedHours, 0) / 8 : 0)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                          {fmtHours(data.roles.reduce((s, r) => s + r.loggedHours, 0))}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{eur(data.totals.budget)}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(data.totals.logged)}</TableCell>
                        <TableCell />
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
        </>
      )}

      {/* Invoice history panel — single project only */}
      {projectId != null && (
        <div className="mt-8">
          <button
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left group"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {historyOpen
              ? <ChevronDown className="h-4 w-4 shrink-0" />
              : <ChevronRight className="h-4 w-4 shrink-0" />
            }
            <History className="h-4 w-4 shrink-0" />
            <span>Invoice history</span>
            {historyQuery.data && historyQuery.data.history.length > 0 && (
              <span className="ml-1 rounded-full bg-white/8 px-1.5 py-0.5 text-xs tabular-nums">
                {historyQuery.data.history.length}
              </span>
            )}
          </button>

          {historyOpen && (
            <div className="mt-3 rounded-xl border border-white/8 overflow-hidden">
              {historyQuery.isLoading && (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              )}
              {historyQuery.isError && (
                <p className="py-8 text-center text-sm text-destructive">Failed to load invoice history.</p>
              )}
              {historyQuery.data && historyQuery.data.history.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">No invoices recorded for this project yet.</p>
              )}
              {historyQuery.data && historyQuery.data.history.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/8 hover:bg-transparent">
                      <TableHead className="w-6 pr-0" />
                      <TableHead>Reference</TableHead>
                      <TableHead className="whitespace-nowrap">Date Invoiced</TableHead>
                      <TableHead>Roles</TableHead>
                      <TableHead>Employees</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyQuery.data.history.map((entry, idx) => {
                      const key = entry.reference ?? `idx-${idx}`;
                      const expanded = expandedHistory.has(key);
                      const toggleRow = () =>
                        setExpandedHistory((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        });
                      const dateLabel = new Date(entry.invoicedAt).toLocaleDateString("de-DE", {
                        day: "2-digit", month: "short", year: "numeric",
                      });

                      return [
                        <TableRow
                          key={`hist-${key}`}
                          className="border-white/8 cursor-pointer hover:bg-white/3"
                          onClick={toggleRow}
                        >
                          <TableCell className="pr-0 pl-3">
                            {expanded
                              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            }
                          </TableCell>
                          <TableCell>
                            {entry.reference
                              ? <span className="font-mono text-sm text-foreground">{entry.reference}</span>
                              : <span className="text-muted-foreground text-sm italic">No reference</span>
                            }
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{dateLabel}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{entry.roleCount} role{entry.roleCount !== 1 ? "s" : ""}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{entry.employeeCount} employee{entry.employeeCount !== 1 ? "s" : ""}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium text-green-400">{eur(entry.totalAmount)}</TableCell>
                        </TableRow>,

                        ...(!expanded ? [] : [
                          <TableRow key={`hist-detail-${key}`} className="border-white/8 hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={5} className="pb-3 pt-1">
                              <div className="flex gap-8 text-sm">
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wide">Roles</p>
                                  <ul className="space-y-0.5">
                                    {entry.roles.map((r) => (
                                      <li key={r.id} className="text-foreground/80">{r.name}</li>
                                    ))}
                                  </ul>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wide">Employees</p>
                                  <ul className="space-y-0.5">
                                    {entry.employees.map((e) => (
                                      <li key={e.id} className="text-foreground/80">{e.name}</li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>,
                        ]),
                      ];
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mark as invoiced modal */}
      <Dialog open={showInvoiceModal} onOpenChange={setShowInvoiceModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as invoiced</DialogTitle>
          </DialogHeader>

          <div className="space-y-2.5 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Project</span>
              <span className="font-medium">{data?.project.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Period</span>
              <span className="font-medium">{periodLabel}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Selected</span>
              <span className="font-medium">{selection.size} item{selection.size !== 1 ? "s" : ""}</span>
            </div>
            {selectedAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount (unbilled)</span>
                <span className="font-semibold text-yellow-400">{eur(selectedAmount)}</span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-ref">Invoice reference (optional)</Label>
            <Input
              id="invoice-ref"
              placeholder={`INV-${format(today, "yyyy-MM")}`}
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowInvoiceModal(false); setInvoiceRef(""); }}>
              Cancel
            </Button>
            <Button
              onClick={() => updateStatusMutation.mutate({ status: "invoiced", invoiceReference: invoiceRef || undefined })}
              disabled={updateStatusMutation.isPending}
            >
              {updateStatusMutation.isPending ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
