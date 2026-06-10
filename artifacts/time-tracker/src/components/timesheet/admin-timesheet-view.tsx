import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListTimeEntries,
  getListTimeEntriesQueryKey,
  useListEmployees,
  getListEmployeesQueryKey,
  useListProjects,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { format, startOfMonth, endOfMonth, subMonths, addMonths } from "date-fns";
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
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Pencil, Trash2, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

interface ProjectRole {
  id: number;
  name: string;
  dayRate: number;
}

interface EditState {
  id: number;
  projectId: string;
  projectRoleId: string;
  hours: string;
  entryDate: string;
  note: string;
}

interface DeleteState {
  id: number;
  label: string;
}

function buildMonthOptions() {
  const today = new Date();
  const options: { value: string; label: string }[] = [];
  for (let i = -12; i <= 3; i++) {
    const d = i < 0 ? subMonths(today, -i) : addMonths(today, i);
    options.push({
      value: format(d, "yyyy-MM"),
      label: format(d, "MMMM yyyy"),
    });
  }
  return options;
}

export function AdminTimesheetView() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(format(today, "yyyy-MM"));
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [noRoleOnly, setNoRoleOnly] = useState(false);
  const [page, setPage] = useState(0);

  const [editState, setEditState] = useState<EditState | null>(null);
  const [editRoleLoading, setEditRoleLoading] = useState(false);
  const [editRoles, setEditRoles] = useState<ProjectRole[]>([]);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);

  const monthOptions = useMemo(buildMonthOptions, []);

  const [year, month] = selectedMonth.split("-").map(Number);
  const monthDate = new Date(year, month - 1, 1);
  const startDate = format(startOfMonth(monthDate), "yyyy-MM-dd");
  const endDate = format(endOfMonth(monthDate), "yyyy-MM-dd");

  const empParams = { includeInactive: false };
  const { data: employees = [] } = useListEmployees(empParams, {
    query: { queryKey: getListEmployeesQueryKey(empParams) },
  });

  const projParams = { includeInactive: false };
  const { data: projects = [] } = useListProjects(projParams, {
    query: { queryKey: getListProjectsQueryKey(projParams) },
  });

  const teParams = {
    startDate,
    endDate,
    ...(employeeFilter !== "all" ? { employeeId: Number(employeeFilter) } : {}),
    ...(projectFilter !== "all" ? { projectId: Number(projectFilter) } : {}),
  };
  const { data: entries = [], isLoading } = useListTimeEntries(teParams, {
    query: { queryKey: getListTimeEntriesQueryKey(teParams) },
  });

  const filtered = useMemo(() => {
    let list = [...entries].sort((a, b) => {
      const da = typeof a.entryDate === "string" ? a.entryDate : String(a.entryDate).slice(0, 10);
      const db2 = typeof b.entryDate === "string" ? b.entryDate : String(b.entryDate).slice(0, 10);
      return db2.localeCompare(da);
    });
    if (noRoleOnly) list = list.filter((e) => !e.roleName);
    return list;
  }, [entries, noRoleOnly]);

  const totalHours = useMemo(() => filtered.reduce((s, e) => s + e.hours, 0), [filtered]);
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const updateMutation = useMutation({
    mutationFn: async (vars: { id: number; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/time-entries/${vars.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListTimeEntriesQueryKey(teParams) });
      setEditState(null);
      toast({ title: "Entry updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/time-entries/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListTimeEntriesQueryKey(teParams) });
      setDeleteState(null);
      toast({ title: "Entry deleted" });
    },
    onError: () => {
      toast({ title: "Delete failed", variant: "destructive" });
    },
  });

  async function openEdit(entry: (typeof entries)[0]) {
    const date = typeof entry.entryDate === "string"
      ? entry.entryDate
      : String(entry.entryDate).slice(0, 10);

    setEditState({
      id: entry.id,
      projectId: String(entry.projectId),
      projectRoleId: entry.projectRoleId != null ? String(entry.projectRoleId) : "__none__",
      hours: String(entry.hours),
      entryDate: date,
      note: entry.note ?? "",
    });

    setEditRoles([]);
    setEditRoleLoading(true);
    try {
      const res = await fetch(`/api/projects/${entry.projectId}/roles`, { credentials: "include" });
      if (res.ok) setEditRoles(await res.json());
    } finally {
      setEditRoleLoading(false);
    }
  }

  async function onProjectChange(projectId: string) {
    if (!editState) return;
    setEditState({ ...editState, projectId, projectRoleId: "__none__" });
    setEditRoles([]);
    setEditRoleLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/roles`, { credentials: "include" });
      if (res.ok) setEditRoles(await res.json());
    } finally {
      setEditRoleLoading(false);
    }
  }

  function handleSave() {
    if (!editState) return;
    const hours = parseFloat(editState.hours);
    if (isNaN(hours) || hours <= 0 || hours > 24) {
      toast({ title: "Hours must be between 0 and 24", variant: "destructive" });
      return;
    }

    const body: Record<string, unknown> = {
      projectId: Number(editState.projectId),
      projectRoleId: editState.projectRoleId && editState.projectRoleId !== "__none__" ? Number(editState.projectRoleId) : null,
      hours,
      entryDate: editState.entryDate,
      note: editState.note || null,
    };
    updateMutation.mutate({ id: editState.id, body });
  }

  function formatDate(d: Date | string) {
    const s = typeof d === "string" ? d : d.toISOString().slice(0, 10);
    const [y, m, day] = s.split("-");
    return `${day}.${m}.${y}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Month</Label>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                const prev = format(subMonths(monthDate, 1), "yyyy-MM");
                setSelectedMonth(prev);
                setPage(0);
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Select
              value={selectedMonth}
              onValueChange={(v) => { setSelectedMonth(v); setPage(0); }}
            >
              <SelectTrigger className="h-8 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                const next = format(addMonths(monthDate, 1), "yyyy-MM");
                setSelectedMonth(next);
                setPage(0);
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Employee</Label>
          <Select value={employeeFilter} onValueChange={(v) => { setEmployeeFilter(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue placeholder="All employees" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Project</Label>
          <Select value={projectFilter} onValueChange={(v) => { setProjectFilter(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="flex items-center gap-2 cursor-pointer h-8 select-none text-sm text-muted-foreground hover:text-foreground transition-colors">
          <input
            type="checkbox"
            className="accent-violet-500 h-4 w-4"
            checked={noRoleOnly}
            onChange={(e) => { setNoRoleOnly(e.target.checked); setPage(0); }}
          />
          No role only
        </label>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground w-[110px]">Date</th>
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Employee</th>
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Project / Role</th>
              <th className="text-right px-3 py-2.5 font-medium text-muted-foreground w-[80px]">Hours</th>
              <th className="px-3 py-2.5 w-[80px]"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-muted-foreground">Loading…</td>
              </tr>
            ) : pageItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-muted-foreground">No entries found</td>
              </tr>
            ) : (
              pageItems.map((entry) => {
                const noRole = !entry.roleName;
                const isDeletingThis = deleteState?.id === entry.id;
                return (
                  <tr
                    key={entry.id}
                    className={cn(
                      "border-b border-border/50 last:border-0",
                      noRole ? "bg-amber-500/5" : "hover:bg-muted/20",
                    )}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                      {formatDate(entry.entryDate)}
                    </td>
                    <td className="px-3 py-2">{entry.employeeName ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span>{entry.projectName ?? "—"}</span>
                      {noRole ? (
                        <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/50 text-amber-500 gap-1 py-0">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          No role
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground"> / {entry.roleName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{entry.hours}h</td>
                    <td className="px-3 py-2">
                      {isDeletingThis ? (
                        <div className="flex items-center gap-1 justify-end">
                          <span className="text-xs text-muted-foreground mr-1">Delete?</span>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 px-2 text-xs"
                            disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate(entry.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => setDeleteState(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(entry)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteState({
                              id: entry.id,
                              label: `${entry.employeeName} – ${entry.projectName} (${formatDate(entry.entryDate)})`,
                            })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30">
                <td colSpan={3} className="px-3 py-2 text-xs text-muted-foreground">
                  {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
                </td>
                <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums">
                  {totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}h
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page + 1} of {pageCount}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      <Dialog open={!!editState} onOpenChange={(open) => { if (!open) setEditState(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Time Entry</DialogTitle>
          </DialogHeader>
          {editState && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select value={editState.projectId} onValueChange={onProjectChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select
                  value={editState.projectRoleId}
                  onValueChange={(v) => setEditState({ ...editState, projectRoleId: v })}
                  disabled={editRoleLoading || editRoles.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={editRoleLoading ? "Loading roles…" : "No role"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— No role —</SelectItem>
                    {editRoles.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={editState.entryDate}
                    onChange={(e) => setEditState({ ...editState, entryDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Hours</Label>
                  <Input
                    type="number"
                    min={0.5}
                    max={24}
                    step={0.5}
                    value={editState.hours}
                    onChange={(e) => setEditState({ ...editState, hours: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  value={editState.note}
                  onChange={(e) => setEditState({ ...editState, note: e.target.value })}
                  placeholder="Add a note…"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditState(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
