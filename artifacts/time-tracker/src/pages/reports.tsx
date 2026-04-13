import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useGetUtilizationReport, 
  getGetUtilizationReportQueryKey,
  useGetProjectReport,
  getGetProjectReportQueryKey,
  useGetClientReport,
  getGetClientReportQueryKey
} from "@workspace/api-client-react";
import { format, subMonths } from "date-fns";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Reports() {
  const [startDate, setStartDate] = useState(format(subMonths(new Date(), 1), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: utilData, isLoading: utilLoading } = useGetUtilizationReport(
    { startDate, endDate },
    { query: { queryKey: getGetUtilizationReportQueryKey({ startDate, endDate }) } }
  );

  const { data: projData, isLoading: projLoading } = useGetProjectReport(
    { startDate, endDate },
    { query: { queryKey: getGetProjectReportQueryKey({ startDate, endDate }) } }
  );

  const { data: clientData, isLoading: clientLoading } = useGetClientReport(
    { startDate, endDate },
    { query: { queryKey: getGetClientReportQueryKey({ startDate, endDate }) } }
  );

  const downloadCSV = (filename: string, headers: string[], rows: any[]) => {
    const csvContent = [
      headers.join(","),
      ...rows.map(row => headers.map(header => {
        const val = row[header];
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `${filename}_${startDate}_to_${endDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>
          
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="start" className="text-xs">Start Date</Label>
              <Input 
                id="start" 
                type="date" 
                value={startDate} 
                onChange={e => setStartDate(e.target.value)} 
                className="h-9 w-auto"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="end" className="text-xs">End Date</Label>
              <Input 
                id="end" 
                type="date" 
                value={endDate} 
                onChange={e => setEndDate(e.target.value)} 
                className="h-9 w-auto"
              />
            </div>
          </div>
        </div>

        <Tabs defaultValue="utilization" className="w-full">
          <TabsList className="grid w-full grid-cols-3 mb-6 bg-muted/50 p-1">
            <TabsTrigger value="utilization">Team Utilization</TabsTrigger>
            <TabsTrigger value="projects">Project Summary</TabsTrigger>
            <TabsTrigger value="clients">Client Summary</TabsTrigger>
          </TabsList>

          <TabsContent value="utilization" className="space-y-4">
            <div className="flex justify-end">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => utilData && downloadCSV("utilization", Object.keys(utilData[0] || {}), utilData)}
                disabled={!utilData?.length}
              >
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            <div className="border rounded-md bg-card overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead className="text-right">Available Hrs</TableHead>
                    <TableHead className="text-right">Billable Hrs</TableHead>
                    <TableHead className="text-right">Non-Billable Hrs</TableHead>
                    <TableHead className="text-right">Total Booked</TableHead>
                    <TableHead className="text-right">Billable Util %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {utilLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8"><Skeleton className="h-4 w-1/2 mx-auto" /></TableCell></TableRow>
                  ) : utilData?.map((row) => (
                    <TableRow key={row.employeeId}>
                      <TableCell className="font-medium">{row.employeeName}</TableCell>
                      <TableCell className="text-right">{row.availableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right font-medium text-primary">{row.billableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.nonBillableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{row.totalBookedHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right font-bold">
                        <span className={row.billableUtilization > 75 ? "text-emerald-600" : row.billableUtilization < 50 ? "text-amber-600" : ""}>
                          {row.billableUtilization.toFixed(1)}%
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                  {utilData?.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No data for selected period</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="projects" className="space-y-4">
            <div className="flex justify-end">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => projData && downloadCSV("projects", Object.keys(projData[0] || {}), projData)}
                disabled={!projData?.length}
              >
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            <div className="border rounded-md bg-card overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Billable Hrs</TableHead>
                    <TableHead className="text-right">Non-Billable Hrs</TableHead>
                    <TableHead className="text-right">Total Hrs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8"><Skeleton className="h-4 w-1/2 mx-auto" /></TableCell></TableRow>
                  ) : projData?.map((row) => (
                    <TableRow key={row.projectId}>
                      <TableCell className="font-medium">{row.projectName}</TableCell>
                      <TableCell>{row.clientName}</TableCell>
                      <TableCell>{row.isBillable ? "Billable" : "Internal"}</TableCell>
                      <TableCell className="text-right font-medium text-primary">{row.billableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.nonBillableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right font-bold">{row.totalHours.toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                  {projData?.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No data for selected period</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="clients" className="space-y-4">
            <div className="flex justify-end">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => clientData && downloadCSV("clients", Object.keys(clientData[0] || {}), clientData)}
                disabled={!clientData?.length}
              >
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            <div className="border rounded-md bg-card overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Billable Hrs</TableHead>
                    <TableHead className="text-right">Non-Billable Hrs</TableHead>
                    <TableHead className="text-right">Total Hrs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientLoading ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8"><Skeleton className="h-4 w-1/2 mx-auto" /></TableCell></TableRow>
                  ) : clientData?.map((row) => (
                    <TableRow key={row.clientId}>
                      <TableCell className="font-medium">{row.clientName}</TableCell>
                      <TableCell className="text-right font-medium text-primary">{row.billableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.nonBillableHours.toFixed(1)}</TableCell>
                      <TableCell className="text-right font-bold">{row.totalHours.toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                  {clientData?.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No data for selected period</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
