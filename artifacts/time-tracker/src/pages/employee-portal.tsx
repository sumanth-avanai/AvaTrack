import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { 
  useGetEmployeeByToken, 
  getGetEmployeeByTokenQueryKey,
  useVerifyEmployeePin
} from "@workspace/api-client-react";
import { TimesheetGrid } from "@/components/timesheet/timesheet-grid";
import { startOfWeek, addWeeks, subWeeks } from "date-fns";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Clock } from "lucide-react";

export default function EmployeePortal() {
  const { token } = useParams<{ token: string }>();
  const [pin, setPin] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));

  // Check session storage on mount
  useEffect(() => {
    const authStatus = sessionStorage.getItem(`zeit_auth_${token}`);
    if (authStatus === "true") {
      setIsAuthenticated(true);
    }
  }, [token]);

  const { data: employee, isLoading, isError } = useGetEmployeeByToken(
    token || "",
    { query: { queryKey: getGetEmployeeByTokenQueryKey(token || ""), enabled: !!token } }
  );

  const verifyPin = useVerifyEmployeePin();

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (!token || !pin) return;

    verifyPin.mutate(
      { data: { token, pin } },
      {
        onSuccess: () => {
          sessionStorage.setItem(`zeit_auth_${token}`, "true");
          setIsAuthenticated(true);
        },
        onError: () => {
          setError("Invalid PIN. Please try again.");
          setPin("");
        }
      }
    );
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-muted/20">Loading...</div>;
  }

  if (isError || !employee) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invalid Link</CardTitle>
            <CardDescription>This personal link is invalid or has expired.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-muted/20 p-4">
        <div className="mb-8 flex items-center gap-2">
          <div className="bg-primary p-2 rounded-md">
            <Clock className="h-6 w-6 text-primary-foreground" />
          </div>
          <span className="text-2xl font-bold tracking-tight text-foreground">Zeit</span>
        </div>
        
        <Card className="w-full max-w-md shadow-lg border-border/50">
          <CardHeader className="space-y-2 text-center pb-6">
            <CardTitle className="text-2xl">Welcome back, {employee.name}</CardTitle>
            <CardDescription>Enter your 4-digit PIN to access your timesheet.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="space-y-2 flex flex-col items-center">
                <Label htmlFor="pin" className="sr-only">PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  pattern="\d{4}"
                  maxLength={4}
                  required
                  autoFocus
                  className="text-center text-2xl tracking-widest h-14 w-48 font-mono"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                />
              </div>
              {error && <p className="text-sm text-destructive text-center font-medium">{error}</p>}
              <Button type="submit" className="w-full h-11" disabled={verifyPin.isPending || pin.length !== 4}>
                {verifyPin.isPending ? "Verifying..." : "Unlock Timesheet"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20 flex flex-col">
      <header className="bg-card border-b border-border py-4 px-6 md:px-8 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-primary p-1.5 rounded-md">
              <Clock className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold tracking-tight text-foreground">Zeit</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">{employee.name}</span>
            <Button variant="ghost" size="sm" onClick={() => {
              sessionStorage.removeItem(`zeit_auth_${token}`);
              setIsAuthenticated(false);
            }}>
              Lock
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 md:p-8 overflow-y-auto">
        <div className="max-w-7xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Your Timesheet</h1>
            <p className="text-sm text-muted-foreground">Log your hours for the week.</p>
          </div>

          <TimesheetGrid 
            employeeId={employee.id}
            weekStartDate={currentWeekStart}
            capacityHours={employee.weeklyCapacityHours || 40}
            workingDaysMask={employee.workingDaysMask}
            contractStartDate={employee.contractStartDate}
            contractEndDate={employee.contractEndDate}
            holidayCalendarCode={employee.holidayCalendarCode}
            onNextWeek={() => setCurrentWeekStart(prev => addWeeks(prev, 1))}
            onPreviousWeek={() => setCurrentWeekStart(prev => subWeeks(prev, 1))}
          />
        </div>
      </main>
    </div>
  );
}
