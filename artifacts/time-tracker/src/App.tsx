import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Clients from "@/pages/clients";
import Projects from "@/pages/projects";
import Employees from "@/pages/employees";
import Holidays from "@/pages/holidays";
import Reports from "@/pages/reports";
import Timesheet from "@/pages/timesheet";
import EmployeePortal from "@/pages/employee-portal";
import Vacations from "@/pages/vacations";
import Login from "@/pages/login";
import { useAppAuth } from "@/hooks/use-app-auth";

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
      <Route path="/"><Redirect to="/dashboard" /></Route>
      <Route path="/dashboard"><AuthGuard><Dashboard /></AuthGuard></Route>
      <Route path="/clients"><AuthGuard><Clients /></AuthGuard></Route>
      <Route path="/projects"><AuthGuard><Projects /></AuthGuard></Route>
      <Route path="/employees"><AuthGuard><Employees /></AuthGuard></Route>
      <Route path="/holidays"><AuthGuard><Holidays /></AuthGuard></Route>
      <Route path="/vacations"><AuthGuard><Vacations /></AuthGuard></Route>
      <Route path="/reports"><AuthGuard><Reports /></AuthGuard></Route>
      <Route path="/timesheet"><AuthGuard><Timesheet /></AuthGuard></Route>
      <Route path="/u/:token"><AuthGuard><EmployeePortal /></AuthGuard></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
