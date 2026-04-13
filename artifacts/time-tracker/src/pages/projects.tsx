import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useListProjects, 
  getListProjectsQueryKey,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useListClients,
  getListClientsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
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
import { Badge } from "@/components/ui/badge";
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
import { Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

export default function Projects() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<any>(null);

  const { data: projects, isLoading: projectsLoading } = useListProjects(
    { includeInactive: true },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: true }) } }
  );

  const { data: clients, isLoading: clientsLoading } = useListClients(
    { includeInactive: true },
    { query: { queryKey: getListClientsQueryKey({ includeInactive: true }) } }
  );

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const budgetHours = formData.get("budgetHours") as string;
    
    createProject.mutate(
      {
        data: {
          name: formData.get("name") as string,
          clientId: Number(formData.get("clientId")),
          code: formData.get("code") as string || null,
          isBillable: formData.get("isBillable") === "on",
          active: formData.get("active") === "on",
          budgetHours: budgetHours ? Number(budgetHours) : null,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          setIsCreateOpen(false);
        }
      }
    );
  };

  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedProject) return;
    const formData = new FormData(e.currentTarget);
    const budgetHours = formData.get("budgetHours") as string;

    updateProject.mutate(
      {
        id: selectedProject.id,
        data: {
          name: formData.get("name") as string,
          clientId: Number(formData.get("clientId")),
          code: formData.get("code") as string || null,
          isBillable: formData.get("isBillable") === "on",
          active: formData.get("active") === "on",
          budgetHours: budgetHours ? Number(budgetHours) : null,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          setIsEditOpen(false);
        }
      }
    );
  };

  const handleToggleActive = (id: number, currentActive: boolean) => {
    updateProject.mutate(
      { id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
        }
      }
    );
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to archive this project?")) {
      deleteProject.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          }
        }
      );
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Projects</h1>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Project</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Project</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="clientId">Client</Label>
                  <Select name="clientId" required disabled={clientsLoading}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input id="name" name="name" required placeholder="Website Redesign" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Project Code (Optional)</Label>
                  <Input id="code" name="code" placeholder="WR-2024" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budgetHours">Budget Hours (Optional)</Label>
                  <Input id="budgetHours" name="budgetHours" type="number" step="0.5" placeholder="100" />
                </div>
                <div className="flex items-center space-x-6">
                  <div className="flex items-center space-x-2">
                    <Switch id="isBillable" name="isBillable" defaultChecked />
                    <Label htmlFor="isBillable">Billable</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch id="active" name="active" defaultChecked />
                    <Label htmlFor="active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createProject.isPending}>
                    {createProject.isPending ? "Creating..." : "Create Project"}
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
                <TableHead>Client</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projectsLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[200px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[80px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[60px] rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-9 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                  </TableRow>
                ))
              ) : projects?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                    No projects found.
                  </TableCell>
                </TableRow>
              ) : (
                projects?.map((project) => (
                  <TableRow key={project.id} className={!project.active ? "opacity-60" : ""}>
                    <TableCell className="font-medium text-muted-foreground">
                      {project.clientName || "Unknown"}
                    </TableCell>
                    <TableCell className="font-semibold">{project.name}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {project.code || "—"}
                    </TableCell>
                    <TableCell>
                      {project.isBillable ? (
                        <Badge variant="default" className="bg-primary/10 text-primary hover:bg-primary/20 font-normal">
                          Billable
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="font-normal">
                          Non-billable
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch 
                        checked={project.active} 
                        onCheckedChange={() => handleToggleActive(project.id, project.active)}
                        disabled={updateProject.isPending}
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
                          <DropdownMenuItem 
                            onClick={() => {
                              setSelectedProject(project);
                              setIsEditOpen(true);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            className="text-destructive focus:text-destructive"
                            onClick={() => handleDelete(project.id)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Archive
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
              <DialogTitle>Edit Project</DialogTitle>
            </DialogHeader>
            {selectedProject && (
              <form onSubmit={handleEdit} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-clientId">Client</Label>
                  <Select name="clientId" defaultValue={selectedProject.clientId.toString()}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-name">Project Name</Label>
                  <Input id="edit-name" name="name" required defaultValue={selectedProject.name} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-code">Project Code</Label>
                  <Input id="edit-code" name="code" defaultValue={selectedProject.code || ""} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-budgetHours">Budget Hours</Label>
                  <Input id="edit-budgetHours" name="budgetHours" type="number" step="0.5" defaultValue={selectedProject.budgetHours || ""} />
                </div>
                <div className="flex items-center space-x-6">
                  <div className="flex items-center space-x-2">
                    <Switch id="edit-isBillable" name="isBillable" defaultChecked={selectedProject.isBillable} />
                    <Label htmlFor="edit-isBillable">Billable</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch id="edit-active" name="active" defaultChecked={selectedProject.active} />
                    <Label htmlFor="edit-active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={updateProject.isPending}>
                    {updateProject.isPending ? "Saving..." : "Save Changes"}
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
