import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { useListEmployees } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AssignedEmployee { employeeId: number; employeeName: string | null }
interface ProjectRole {
  id: number;
  projectId: number;
  name: string;
  dayRate: number;
  budgetedDays: number | null;
  budgetedHours: number | null;
  assignedEmployees: AssignedEmployee[];
}
interface BudgetRole extends ProjectRole {
  bookedHours: number;
  bookedDays: number;
  plannedHours: number;
  plannedDays: number;
  budgetValue: number | null;
  bookedValue: number;
  remainingDays: number | null;
  utilization: number | null;
}
interface BudgetResponse {
  roles: BudgetRole[];
  totals: {
    budgetedDays: number;
    budgetedHours: number;
    budgetValue: number;
    bookedHours: number;
    bookedValue: number;
    remainingDays: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

const fmtDays = (d: number) => `${d % 1 === 0 ? d : d.toFixed(1)}d`;

function UtilBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground text-xs">—</span>;
  const pctVal = pct * 100;
  const color =
    pctVal > 100 ? "text-destructive" : pctVal >= 80 ? "text-yellow-600" : "text-green-600";
  return <span className={`text-xs font-medium ${color}`}>{pctVal.toFixed(0)}%</span>;
}

function UtilBar({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const pctClamped = Math.min(pct * 100, 100);
  const isOver = pct > 1;
  const isWarn = pct >= 0.8;
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <Progress
        value={pctClamped}
        className={`h-2 flex-1 ${isOver ? "[&>div]:bg-destructive" : isWarn ? "[&>div]:bg-yellow-500" : "[&>div]:bg-green-500"}`}
      />
      <UtilBadge pct={pct} />
    </div>
  );
}

// ── Role Form ──────────────────────────────────────────────────────────────────
interface RoleFormState {
  name: string;
  dayRate: string;
  budgetedDays: string;
  assignedEmployeeIds: number[];
}

function RoleModal({
  open,
  title,
  initial,
  employees,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  title: string;
  initial: RoleFormState;
  employees: { id: number; name: string }[];
  onClose: () => void;
  onSave: (data: RoleFormState) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<RoleFormState>(initial);

  useEffect(() => {
    if (open) setForm(initial);
  }, [open]);

  const dayRate = parseFloat(form.dayRate) || 0;
  const budgDays = parseFloat(form.budgetedDays) || 0;
  const budgHours = budgDays * 8;
  const budgValue = budgDays * dayRate;

  function toggleEmployee(id: number) {
    setForm((f) => ({
      ...f,
      assignedEmployeeIds: f.assignedEmployeeIds.includes(id)
        ? f.assignedEmployeeIds.filter((e) => e !== id)
        : [...f.assignedEmployeeIds, id],
    }));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Role Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Tech Lead"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Day Rate (€)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={form.dayRate}
              onChange={(e) => setForm((f) => ({ ...f, dayRate: e.target.value }))}
              placeholder="1356.60"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Budgeted Days <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={form.budgetedDays}
              onChange={(e) => setForm((f) => ({ ...f, budgetedDays: e.target.value }))}
              placeholder="50"
            />
            {budgDays > 0 && (
              <p className="text-xs text-muted-foreground">
                = {budgHours}h &nbsp;|&nbsp; {fmt(budgValue)} total
              </p>
            )}
          </div>
          {employees.length > 0 && (
            <div className="space-y-1.5">
              <Label>Assign Employees <span className="text-muted-foreground">(optional)</span></Label>
              <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                {employees.map((emp) => (
                  <label
                    key={emp.id}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={form.assignedEmployeeIds.includes(emp.id)}
                      onCheckedChange={() => toggleEmployee(emp.id)}
                    />
                    <span className="text-sm">{emp.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => onSave(form)}
            disabled={saving || !form.name.trim() || !form.dayRate}
          >
            {saving ? "Saving…" : "Save Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Sheet ─────────────────────────────────────────────────────────────────
interface Props {
  project: { id: number; name: string } | null;
  open: boolean;
  onClose: () => void;
}

export function ProjectRolesSheet({ project, open, onClose }: Props) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editRole, setEditRole] = useState<ProjectRole | null>(null);

  const rolesKey = ["project-roles", project?.id];
  const budgetKey = ["project-budget", project?.id];

  const { data: roles = [], isLoading: rolesLoading } = useQuery<ProjectRole[]>({
    queryKey: rolesKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project!.id}/roles`);
      if (!res.ok) throw new Error("Failed to fetch roles");
      return res.json();
    },
    enabled: open && project != null,
  });

  const { data: budget, isLoading: budgetLoading } = useQuery<BudgetResponse>({
    queryKey: budgetKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project!.id}/budget`);
      if (!res.ok) throw new Error("Failed to fetch budget");
      return res.json();
    },
    enabled: open && project != null,
  });

  const { data: employees = [] } = useListEmployees({ includeInactive: false });
  const activeEmployees = (employees as { id: number; name: string }[]).map((e) => ({
    id: e.id,
    name: e.name,
  }));

  function invalidate() {
    qc.invalidateQueries({ queryKey: rolesKey });
    qc.invalidateQueries({ queryKey: budgetKey });
  }

  const createRole = useMutation({
    mutationFn: async (data: RoleFormState) => {
      const res = await fetch(`/api/projects/${project!.id}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name.trim(),
          dayRate: parseFloat(data.dayRate),
          budgetedDays: data.budgetedDays ? parseFloat(data.budgetedDays) : null,
          budgetedHours: data.budgetedDays ? parseFloat(data.budgetedDays) * 8 : null,
          assignedEmployeeIds: data.assignedEmployeeIds,
        }),
      });
      if (!res.ok) throw new Error("Failed to create role");
      return res.json();
    },
    onSuccess: () => { invalidate(); setAddOpen(false); },
  });

  const updateRole = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: RoleFormState }) => {
      const res = await fetch(`/api/project-roles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name.trim(),
          dayRate: parseFloat(data.dayRate),
          budgetedDays: data.budgetedDays ? parseFloat(data.budgetedDays) : null,
          budgetedHours: data.budgetedDays ? parseFloat(data.budgetedDays) * 8 : null,
          assignedEmployeeIds: data.assignedEmployeeIds,
        }),
      });
      if (!res.ok) throw new Error("Failed to update role");
      return res.json();
    },
    onSuccess: () => { invalidate(); setEditRole(null); },
  });

  const deleteRole = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/project-roles/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete role");
    },
    onSuccess: () => invalidate(),
  });

  // Totals for roles tab footer
  const totalBudgetDays = roles.reduce((s, r) => s + (r.budgetedDays ?? 0), 0);
  const totalBudgetValue = roles.reduce((s, r) => s + (r.budgetedDays ?? 0) * r.dayRate, 0);

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto flex flex-col">
          <SheetHeader className="pb-2 border-b">
            <SheetTitle className="text-lg">{project?.name ?? ""}</SheetTitle>
          </SheetHeader>

          <Tabs defaultValue="roles" className="flex-1 flex flex-col pt-4">
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="roles">Roles</TabsTrigger>
              <TabsTrigger value="budget">Budget</TabsTrigger>
            </TabsList>

            {/* ── ROLES TAB ─────────────────────────────────────────────────── */}
            <TabsContent value="roles" className="flex-1 flex flex-col space-y-4">
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4 mr-1.5" /> Add Role
                </Button>
              </div>

              {rolesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : roles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No roles defined yet. Add a role to get started.
                </p>
              ) : (
                <>
                  <div className="border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Role</TableHead>
                          <TableHead className="text-right">Day Rate</TableHead>
                          <TableHead className="text-right">Budget</TableHead>
                          <TableHead>Assigned</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {roles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell className="font-medium">{role.name}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {fmt(role.dayRate)}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {role.budgetedDays != null
                                ? `${fmtDays(role.budgetedDays)} (${role.budgetedDays * 8}h)`
                                : "—"}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {role.assignedEmployees.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">—</span>
                                ) : (
                                  role.assignedEmployees.map((a) => (
                                    <Badge key={a.employeeId} variant="secondary" className="text-xs font-normal">
                                      {a.employeeName ?? `#${a.employeeId}`}
                                    </Badge>
                                  ))
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => setEditRole(role)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => {
                                    if (confirm(`Delete role "${role.name}"?`)) {
                                      deleteRole.mutate(role.id);
                                    }
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {totalBudgetDays > 0 && (
                    <div className="text-sm text-muted-foreground text-right">
                      Total: {fmtDays(totalBudgetDays)} &nbsp;|&nbsp; {fmt(totalBudgetValue)}
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            {/* ── BUDGET TAB ────────────────────────────────────────────────── */}
            <TabsContent value="budget" className="flex-1 space-y-4">
              {budgetLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : !budget || budget.roles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No roles defined. Add roles to track budget.
                </p>
              ) : (
                <>
                  <div className="border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Role</TableHead>
                          <TableHead className="text-right">Budget</TableHead>
                          <TableHead className="text-right">Booked</TableHead>
                          <TableHead className="text-right">Remaining</TableHead>
                          <TableHead className="min-w-[140px]">Utilization</TableHead>
                          <TableHead className="text-right">Booked Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {budget.roles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell className="font-medium">{role.name}</TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {role.budgetedDays != null
                                ? `${fmtDays(role.budgetedDays)}`
                                : "—"}
                              {role.budgetValue != null && (
                                <div className="text-xs text-muted-foreground/70">{fmt(role.budgetValue)}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {fmtDays(role.bookedDays)}
                              <div className="text-xs text-muted-foreground/70">{fmt(role.bookedValue)}</div>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {role.remainingDays != null ? (
                                <span className={role.remainingDays < 0 ? "text-destructive font-semibold" : ""}>
                                  {role.remainingDays < 0 && <AlertTriangle className="inline h-3 w-3 mr-0.5" />}
                                  {fmtDays(Math.abs(role.remainingDays))}
                                  {role.remainingDays < 0 ? " over" : ""}
                                </span>
                              ) : "—"}
                            </TableCell>
                            <TableCell>
                              <UtilBar pct={role.utilization} />
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {fmt(role.bookedValue)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Totals summary card */}
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                    <div className="font-semibold text-foreground">Project Total</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <div className="text-xs text-muted-foreground">Budgeted</div>
                        <div className="font-medium">{fmtDays(budget.totals.budgetedDays)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(budget.totals.budgetValue)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Booked</div>
                        <div className="font-medium">{fmtDays(budget.totals.bookedHours / 8)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(budget.totals.bookedValue)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Remaining</div>
                        <div className={`font-medium ${budget.totals.remainingDays < 0 ? "text-destructive" : ""}`}>
                          {budget.totals.remainingDays < 0 && <AlertTriangle className="inline h-3 w-3 mr-0.5" />}
                          {fmtDays(Math.abs(budget.totals.remainingDays))}
                          {budget.totals.remainingDays < 0 ? " over" : ""}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Remaining Value</div>
                        <div className="font-medium">
                          {fmt(Math.max(0, budget.totals.budgetValue - budget.totals.bookedValue))}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      {/* Add Role Modal */}
      <RoleModal
        open={addOpen}
        title="Add Role"
        initial={{ name: "", dayRate: "", budgetedDays: "", assignedEmployeeIds: [] }}
        employees={activeEmployees}
        onClose={() => setAddOpen(false)}
        onSave={(data) => createRole.mutate(data)}
        saving={createRole.isPending}
      />

      {/* Edit Role Modal */}
      <RoleModal
        open={editRole != null}
        title="Edit Role"
        initial={
          editRole
            ? {
                name: editRole.name,
                dayRate: String(editRole.dayRate),
                budgetedDays: editRole.budgetedDays != null ? String(editRole.budgetedDays) : "",
                assignedEmployeeIds: editRole.assignedEmployees.map((a) => a.employeeId),
              }
            : { name: "", dayRate: "", budgetedDays: "", assignedEmployeeIds: [] }
        }
        employees={activeEmployees}
        onClose={() => setEditRole(null)}
        onSave={(data) => updateRole.mutate({ id: editRole!.id, data })}
        saving={updateRole.isPending}
      />
    </>
  );
}
