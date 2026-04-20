import { useLocation } from "wouter";
import { AdminLayout } from "@/components/layout/admin-layout";
import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Clock, FolderKanban, Users, BarChart3, CalendarRange, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDirtyGuard } from "@/contexts/dirty-guard";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function Home() {
  const [, navigate] = useLocation();
  const { guardNavigate } = useDirtyGuard();

  const { data: summary, isLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const stats = [
    {
      label: "Active Projects",
      value: summary?.activeProjects ?? 0,
      icon: FolderKanban,
      color: "text-blue-500",
      bg: "bg-blue-50 dark:bg-blue-950/30",
    },
    {
      label: "Active Employees",
      value: summary?.activeEmployees ?? 0,
      icon: Users,
      color: "text-emerald-500",
      bg: "bg-emerald-50 dark:bg-emerald-950/30",
    },
    {
      label: "Hours Logged This Week",
      value: summary?.hoursThisWeek != null ? `${summary.hoursThisWeek}h` : "—",
      icon: Clock,
      color: "text-violet-500",
      bg: "bg-violet-50 dark:bg-violet-950/30",
    },
    {
      label: "Hours Logged This Month",
      value: summary?.hoursThisMonth != null ? `${summary.hoursThisMonth}h` : "—",
      icon: BarChart3,
      color: "text-amber-500",
      bg: "bg-amber-50 dark:bg-amber-950/30",
    },
  ];

  const quickActions = [
    { label: "Log Time",        href: "/timesheet",        icon: Clock,         description: "Open the timesheet and log your hours" },
    { label: "Resource Planner",href: "/resource-planner", icon: CalendarRange, description: "Plan and review team allocations" },
    { label: "Projects",        href: "/projects",         icon: FolderKanban,  description: "Browse projects grouped by client" },
    { label: "Reports",         href: "/reports",          icon: BarChart3,     description: "View budget and time reports" },
  ];

  return (
    <AdminLayout>
      <div className="space-y-8 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{greeting()}</h1>
          <p className="text-muted-foreground text-sm mt-1">Here's what's happening in your agency today.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-card border border-border rounded-lg p-4 space-y-2">
              <div className={`inline-flex items-center justify-center h-8 w-8 rounded-md ${s.bg}`}>
                <s.icon className={`h-4 w-4 ${s.color}`} />
              </div>
              {isLoading ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <div className="text-2xl font-bold tabular-nums">{s.value}</div>
              )}
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Quick actions */}
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Quick Actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {quickActions.map((action) => (
              <button
                key={action.href}
                onClick={() => guardNavigate(() => navigate(action.href))}
                className="flex items-center gap-4 bg-card border border-border rounded-lg p-4 text-left hover:border-primary/50 hover:shadow-sm transition-all group"
              >
                <div className="flex-shrink-0 h-10 w-10 rounded-md bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <action.icon className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-foreground">{action.label}</div>
                  <div className="text-xs text-muted-foreground truncate">{action.description}</div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 group-hover:text-primary transition-colors" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
