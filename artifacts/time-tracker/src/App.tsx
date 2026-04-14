import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
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

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard"  component={Dashboard} />
      <Route path="/clients"    component={Clients} />
      <Route path="/projects"   component={Projects} />
      <Route path="/employees"  component={Employees} />
      <Route path="/holidays"   component={Holidays} />
      <Route path="/vacations"  component={Vacations} />
      <Route path="/reports"    component={Reports} />
      <Route path="/timesheet"  component={Timesheet} />

      <Route path="/u/:token" component={EmployeePortal} />

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
