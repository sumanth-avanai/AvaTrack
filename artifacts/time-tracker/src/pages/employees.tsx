import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useListEmployees, 
  getListEmployeesQueryKey,
  useCreateEmployee,
  useUpdateEmployee,
  useDeleteEmployee,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  useResetEmployeePin
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger,
  DialogFooter
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, MoreHorizontal, Pencil, Trash2, Link as LinkIcon, RefreshCw } from "lucide-react";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function Employees() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<any>(null);

  const { data: employees, isLoading: employeesLoading } = useListEmployees(
    { includeInactive: true },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: true }) } }
  );

  const { data: calendars } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() }
  });

  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();
  const deleteEmployee = useDeleteEmployee();
  const resetPin = useResetEmployeePin();

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    // Default Mon-Fri working days
    const workingDaysMask = [0, 1, 1, 1, 1, 1, 0];
    
    createEmployee.mutate(
      {
        data: {
          name: formData.get("name") as string,
          email: formData.get("email") as string || null,
          weeklyCapacityHours: Number(formData.get("weeklyCapacityHours")),
          holidayCalendarCode: formData.get("holidayCalendarCode") as string || null,
          active: formData.get("active") === "on",
          workingDaysMask,
          pin: formData.get("pin") as string,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });
          setIsCreateOpen(false);
          toast({ title: "Employee created successfully" });
        }
      }
    );
  };

  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedEmployee) return;
    const formData = new FormData(e.currentTarget);

    updateEmployee.mutate(
      {
        id: selectedEmployee.id,
        data: {
          name: formData.get("name") as string,
          email: formData.get("email") as string || null,
          weeklyCapacityHours: Number(formData.get("weeklyCapacityHours")),
          holidayCalendarCode: formData.get("holidayCalendarCode") as string || null,
          active: formData.get("active") === "on",
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });
          setIsEditOpen(false);
          toast({ title: "Employee updated successfully" });
        }
      }
    );
  };

  const handleToggleActive = (id: number, currentActive: boolean) => {
    updateEmployee.mutate(
      { id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to deactivate this employee?")) {
      deleteEmployee.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });
          }
        }
      );
    }
  };

  const handleResetPin = (id: number) => {
    const pin = prompt("Enter a new 4-digit PIN for this employee:");
    if (pin && /^\d{4}$/.test(pin)) {
      resetPin.mutate(
        { id, data: { pin } },
        {
          onSuccess: () => {
            toast({ title: "PIN reset successfully" });
          }
        }
      );
    } else if (pin) {
      toast({ title: "Invalid PIN format", description: "Must be 4 digits", variant: "destructive" });
    }
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/u/${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Copied to clipboard", description: "Personal link copied" });
  };

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Employees</h1>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Employee</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Employee</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" required placeholder="Jane Doe" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" placeholder="jane@example.com" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="weeklyCapacityHours">Weekly Capacity (Hours)</Label>
                  <Input id="weeklyCapacityHours" name="weeklyCapacityHours" type="number" required defaultValue="40" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="holidayCalendarCode">Holiday Calendar</Label>
                  <Select name="holidayCalendarCode">
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {calendars?.map((c) => (
                        <SelectItem key={c.id} value={c.code}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pin">Initial PIN (4 digits)</Label>
                  <Input id="pin" name="pin" required pattern="\d{4}" placeholder="1234" maxLength={4} />
                </div>
                <div className="flex items-center space-x-2">
                  <Switch id="active" name="active" defaultChecked />
                  <Label htmlFor="active">Active</Label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createEmployee.isPending}>
                    {createEmployee.isPending ? "Creating..." : "Create Employee"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="border rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employeesLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[200px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[80px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-9 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                  </TableRow>
                ))
              ) : employees?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                    No employees found.
                  </TableCell>
                </TableRow>
              ) : (
                employees?.map((employee) => (
                  <TableRow key={employee.id} className={!employee.active ? "opacity-60" : ""}>
                    <TableCell className="font-semibold">{employee.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {employee.email || "—"}
                    </TableCell>
                    <TableCell>{employee.weeklyCapacityHours}h/wk</TableCell>
                    <TableCell>
                      <Switch 
                        checked={employee.active} 
                        onCheckedChange={() => handleToggleActive(employee.id, employee.active)}
                        disabled={updateEmployee.isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0">
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => copyLink(employee.personalAccessToken)}>
                            <LinkIcon className="mr-2 h-4 w-4" />
                            Copy Personal Link
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResetPin(employee.id)}>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Reset PIN
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => {
                              setSelectedEmployee(employee);
                              setIsEditOpen(true);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Employee</DialogTitle>
            </DialogHeader>
            {selectedEmployee && (
              <form onSubmit={handleEdit} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-name">Name</Label>
                  <Input id="edit-name" name="name" required defaultValue={selectedEmployee.name} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-email">Email</Label>
                  <Input id="edit-email" name="email" type="email" defaultValue={selectedEmployee.email || ""} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-capacity">Weekly Capacity (Hours)</Label>
                  <Input id="edit-capacity" name="weeklyCapacityHours" type="number" required defaultValue={selectedEmployee.weeklyCapacityHours} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-holidayCalendarCode">Holiday Calendar</Label>
                  <Select name="holidayCalendarCode" defaultValue={selectedEmployee.holidayCalendarCode || "none"}>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {calendars?.map((c) => (
                        <SelectItem key={c.id} value={c.code}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2">
                  <Switch id="edit-active" name="active" defaultChecked={selectedEmployee.active} />
                  <Label htmlFor="edit-active">Active</Label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={updateEmployee.isPending}>
                    {updateEmployee.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
