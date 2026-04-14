import { Link, useLocation } from "wouter";
import { 
  Sidebar, 
  SidebarContent, 
  SidebarHeader, 
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
} from "lucide-react";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "Timesheet", href: "/timesheet", icon: Clock },
    { title: "Clients", href: "/clients", icon: Briefcase },
    { title: "Projects", href: "/projects", icon: FolderKanban },
    { title: "Employees", href: "/employees", icon: Users },
    { title: "Holidays",  href: "/holidays",  icon: CalendarDays },
    { title: "Vacations", href: "/vacations", icon: CalendarOff },
    { title: "Reports",   href: "/reports",   icon: BarChart3 },
  ];

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
                    asChild 
                    isActive={location.startsWith(item.href)}
                    className="w-full"
                  >
                    <Link href={item.href} className="flex items-center gap-3 px-3 py-2 text-sm font-medium">
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
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
