import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { format, startOfWeek, addDays, isSameDay, parseISO } from "date-fns";
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
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  useListProjects, 
  getListProjectsQueryKey,
  useListTimeEntries,
  getListTimeEntriesQueryKey,
  useBulkUpsertTimeEntries
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Copy, Save, CheckCircle2 } from "lucide-react";

interface TimesheetGridProps {
  employeeId: number;
  weekStartDate: Date;
  capacityHours: number;
  onPreviousWeek?: () => void;
  onNextWeek?: () => void;
}

export function TimesheetGrid({ employeeId, weekStartDate, capacityHours, onPreviousWeek, onNextWeek }: TimesheetGridProps) {
  const queryClient = useQueryClient();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => addDays(weekStartDate, i));
  }, [weekStartDate]);

  const startDateStr = format(weekDays[0], "yyyy-MM-dd");
  const endDateStr = format(weekDays[6], "yyyy-MM-dd");

  const { data: projects } = useListProjects(
    { includeInactive: false },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) } }
  );

  const { data: timeEntries, isLoading: entriesLoading } = useListTimeEntries(
    { employeeId, startDate: startDateStr, endDate: endDateStr },
    { 
      query: { 
        queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
        enabled: !!employeeId
      } 
    }
  );

  const bulkUpsert = useBulkUpsertTimeEntries();

  // State to hold grid data: projectId -> { dateString -> hours }
  const [gridData, setGridData] = useState<Record<number, Record<string, string>>>({});
  const [activeProjectIds, setActiveProjectIds] = useState<number[]>([]);
  
  const initializedForParams = useRef<string | null>(null);
  const currentParamsKey = `${employeeId}-${startDateStr}-${endDateStr}`;

  // Initialize grid from server data
  useEffect(() => {
    if (timeEntries && projects && initializedForParams.current !== currentParamsKey) {
      initializedForParams.current = currentParamsKey;
      
      const newGrid: Record<number, Record<string, string>> = {};
      const activeIds = new Set<number>();

      timeEntries.forEach(entry => {
        if (!newGrid[entry.projectId]) {
          newGrid[entry.projectId] = {};
        }
        newGrid[entry.projectId][entry.entryDate] = entry.hours.toString();
        activeIds.add(entry.projectId);
      });

      setGridData(newGrid);
      setActiveProjectIds(Array.from(activeIds));
    }
  }, [timeEntries, projects, currentParamsKey]);

  // Debounced auto-save
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedData = useRef(JSON.stringify(gridData));

  const triggerSave = useCallback((dataToSave: Record<number, Record<string, string>>) => {
    const currentDataStr = JSON.stringify(dataToSave);
    if (currentDataStr === lastSavedData.current) return;
    
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setSaveStatus("saving");
    saveTimeoutRef.current = setTimeout(() => {
      const entriesToSave = [];
      
      for (const projectIdStr in dataToSave) {
        const projectId = parseInt(projectIdStr);
        for (const date in dataToSave[projectId]) {
          const hoursStr = dataToSave[projectId][date];
          const hours = parseFloat(hoursStr);
          
          if (!isNaN(hours)) {
            entriesToSave.push({
              employeeId,
              projectId,
              entryDate: date,
              hours
            });
          }
        }
      }

      bulkUpsert.mutate(
        { data: { entries: entriesToSave } },
        {
          onSuccess: () => {
            setSaveStatus("saved");
            lastSavedData.current = currentDataStr;
            queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }) });
            setTimeout(() => setSaveStatus("idle"), 2000);
          },
          onError: () => {
            setSaveStatus("idle");
          }
        }
      );
    }, 1500);
  }, [employeeId, bulkUpsert, queryClient, startDateStr, endDateStr]);

  const handleCellChange = (projectId: number, date: string, value: string) => {
    const newGrid = { ...gridData };
    if (!newGrid[projectId]) {
      newGrid[projectId] = {};
    }
    
    // Only allow numbers and empty string
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      newGrid[projectId][date] = value;
      setGridData(newGrid);
      triggerSave(newGrid);
    }
  };

  const handleAddProject = (projectIdStr: string) => {
    const projectId = parseInt(projectIdStr);
    if (!isNaN(projectId) && !activeProjectIds.includes(projectId)) {
      setActiveProjectIds([...activeProjectIds, projectId]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, rowIndex: number, colIndex: number) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      const nextRow = document.querySelector(`input[data-row="${rowIndex + 1}"][data-col="${colIndex}"]`) as HTMLInputElement;
      if (nextRow) nextRow.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevRow = document.querySelector(`input[data-row="${rowIndex - 1}"][data-col="${colIndex}"]`) as HTMLInputElement;
      if (prevRow) prevRow.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const nextCol = document.querySelector(`input[data-row="${rowIndex}"][data-col="${colIndex + 1}"]`) as HTMLInputElement;
      if (nextCol) nextCol.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prevCol = document.querySelector(`input[data-row="${rowIndex}"][data-col="${colIndex - 1}"]`) as HTMLInputElement;
      if (prevCol) prevCol.focus();
    }
  };

  // Calculate totals
  const colTotals = weekDays.map(day => {
    const dateStr = format(day, "yyyy-MM-dd");
    let total = 0;
    activeProjectIds.forEach(pId => {
      const val = parseFloat(gridData[pId]?.[dateStr] || "0");
      if (!isNaN(val)) total += val;
    });
    return total;
  });

  const rowTotals = activeProjectIds.map(pId => {
    let total = 0;
    weekDays.forEach(day => {
      const val = parseFloat(gridData[pId]?.[format(day, "yyyy-MM-dd")] || "0");
      if (!isNaN(val)) total += val;
    });
    return total;
  });

  const grandTotal = colTotals.reduce((a, b) => a + b, 0);
  const isOverCapacity = grandTotal > capacityHours;

  if (entriesLoading && !initializedForParams.current) {
    return <div className="p-8 text-center text-muted-foreground">Loading timesheet...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={onPreviousWeek} size="sm">&larr; Prev Week</Button>
          <div className="font-medium text-sm">
            {format(weekDays[0], "MMM d")} - {format(weekDays[6], "MMM d, yyyy")}
          </div>
          <Button variant="outline" onClick={onNextWeek} size="sm">Next Week &rarr;</Button>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-sm">
            {saveStatus === "saving" && (
              <span className="flex items-center text-muted-foreground"><Save className="h-4 w-4 mr-1 animate-pulse" /> Saving...</span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center text-primary"><CheckCircle2 className="h-4 w-4 mr-1" /> Saved</span>
            )}
          </div>
          
          <div className={`px-3 py-1.5 rounded-md text-sm font-medium border ${isOverCapacity ? 'bg-destructive/10 text-destructive border-destructive/20' : 'bg-muted/50 border-border'}`}>
            {grandTotal.toFixed(1)} / {capacityHours} hrs
          </div>
        </div>
      </div>

      <div className="border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[250px]">Project</TableHead>
              {weekDays.map(day => (
                <TableHead key={day.toISOString()} className="text-center w-[100px]">
                  <div className="flex flex-col items-center">
                    <span className="font-medium text-foreground">{format(day, "EEE")}</span>
                    <span className="text-xs text-muted-foreground">{format(day, "MMM d")}</span>
                  </div>
                </TableHead>
              ))}
              <TableHead className="text-right w-[100px]">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeProjectIds.map((projectId, rowIndex) => {
              const project = projects?.find(p => p.id === projectId);
              return (
                <TableRow key={projectId}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span className="truncate">{project?.name || `Project ${projectId}`}</span>
                      <span className="text-xs text-muted-foreground truncate">{project?.clientName}</span>
                    </div>
                  </TableCell>
                  {weekDays.map((day, colIndex) => {
                    const dateStr = format(day, "yyyy-MM-dd");
                    return (
                      <TableCell key={dateStr} className="p-1">
                        <Input
                          type="text"
                          className="h-9 w-full text-center border-transparent hover:border-input focus:border-ring rounded-sm bg-transparent"
                          value={gridData[projectId]?.[dateStr] || ""}
                          onChange={(e) => handleCellChange(projectId, dateStr, e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                          data-row={rowIndex}
                          data-col={colIndex}
                          placeholder="-"
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-medium bg-muted/20">
                    {rowTotals[rowIndex].toFixed(1)}
                  </TableCell>
                </TableRow>
              );
            })}
            
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="p-2">
                <Select onValueChange={handleAddProject}>
                  <SelectTrigger className="h-8 border-dashed bg-transparent w-full">
                    <SelectValue placeholder="+ Add project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects?.filter(p => !activeProjectIds.includes(p.id)).map(p => (
                      <SelectItem key={p.id} value={p.id.toString()}>{p.name} ({p.clientName})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              {colTotals.map((total, i) => (
                <TableCell key={i} className="text-center font-medium">
                  {total > 0 ? total.toFixed(1) : "-"}
                </TableCell>
              ))}
              <TableCell className="text-right font-bold text-primary">
                {grandTotal > 0 ? grandTotal.toFixed(1) : "0.0"}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
