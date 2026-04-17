import { useLocation } from "wouter";
import { 
  Sidebar, 
  SidebarContent, 
  SidebarHeader, 
  SidebarFooter,
  SidebarMenu, 
  SidebarMenuButton, 
  SidebarMenuItem,
  SidebarProvider
} from "@/components/ui/sidebar";
import { 
  LayoutDashboard, 
  Clock, 
  Users, 
  FolderKanban, 
  Briefcase, 
  CalendarDays, 
  BarChart3,
  CalendarOff,
  LogOut,
  CalendarRange,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useSetUnauthenticated } from "@/hooks/use-app-auth";
import { useDirtyGuard } from "@/contexts/dirty-guard";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { guardNavigate } = useDirtyGuard();
  const { toast } = useToast();
  const setUnauthenticated = useSetUnauthenticated();

  const navItems = [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "Timesheet", href: "/timesheet", icon: Clock },
    { title: "Clients", href: "/clients", icon: Briefcase },
    { title: "Projects", href: "/projects", icon: FolderKanban },
    { title: "Employees", href: "/employees", icon: Users },
    { title: "Holidays",  href: "/holidays",  icon: CalendarDays },
    { title: "Vacations", href: "/vacations", icon: CalendarOff },
    { title: "Reports",          href: "/reports",           icon: BarChart3 },
    { title: "Resource Planner", href: "/resource-planner",  icon: CalendarRange },
  ];

  async function handleLogout() {
    try {
      await fetch("/api/auth/app/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore network errors — still clear local state and navigate
    }
    // Immediately update cache so AuthGuard sees unauthenticated state
    setUnauthenticated();
    navigate("/login");
    toast({ title: "Signed out" });
  }

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-muted/20">
        <Sidebar className="border-r border-border">
          <SidebarHeader className="h-16 flex items-center px-4 border-b border-border">
            <div className="font-bold text-lg tracking-tight text-sidebar-primary">Zeit</div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarMenu className="p-2 gap-1">
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={location.startsWith(item.href)}
                    className="w-full"
                    onClick={(e) => {
                      e.preventDefault();
                      guardNavigate(() => navigate(item.href));
                    }}
                  >
                    <div className="flex items-center gap-3 px-3 py-2 text-sm font-medium w-full cursor-pointer">
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="p-2 border-t border-border">
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 md:p-8">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
