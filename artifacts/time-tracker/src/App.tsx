import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Clients from "@/pages/clients";
import Projects from "@/pages/projects";
import Employees from "@/pages/employees";
import EmployeeDetail from "@/pages/employee-detail";
import Holidays from "@/pages/holidays";
import Settings from "@/pages/settings";
import Reports from "@/pages/reports";
import Timesheet from "@/pages/timesheet";
import EmployeePortal from "@/pages/employee-portal";
import Login from "@/pages/login";
import ResourcePlanner from "@/pages/resource-planner";
import { useAppAuth } from "@/hooks/use-app-auth";
import { DirtyGuardProvider } from "@/contexts/dirty-guard";

const queryClient = new QueryClient();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  const auth = useAppAuth();

  useEffect(() => {
    if (auth === "unauthenticated") {
      navigate("/login");
    }
  }, [auth, navigate]);

  if (auth === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (auth === "unauthenticated") return null;

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />

      {/* Redirects for old/removed routes */}
      <Route path="/"><Redirect to="/home" /></Route>
      <Route path="/dashboard"><Redirect to="/home" /></Route>
      <Route path="/clients"><Redirect to="/projects" /></Route>
      <Route path="/holidays"><Redirect to="/settings" /></Route>

      {/* Main routes */}
      <Route path="/home"><AuthGuard><Home /></AuthGuard></Route>
      <Route path="/timesheet"><AuthGuard><Timesheet /></AuthGuard></Route>
      <Route path="/resource-planner"><AuthGuard><ResourcePlanner /></AuthGuard></Route>
      <Route path="/projects"><AuthGuard><Projects /></AuthGuard></Route>
      <Route path="/employees/:id"><AuthGuard><EmployeeDetail /></AuthGuard></Route>
      <Route path="/employees"><AuthGuard><Employees /></AuthGuard></Route>
      <Route path="/reports"><AuthGuard><Reports /></AuthGuard></Route>
      <Route path="/settings"><AuthGuard><Settings /></AuthGuard></Route>
      <Route path="/vacations"><Redirect to="/employees" /></Route>

      <Route path="/u/:token"><AuthGuard><EmployeePortal /></AuthGuard></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DirtyGuardProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </DirtyGuardProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
