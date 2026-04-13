import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { format, addDays } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
  useBulkUpsertTimeEntries,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Save, CheckCircle2, Loader2 } from "lucide-react";

interface TimesheetGridProps {
  employeeId: number;
  weekStartDate: Date;
  capacityHours: number;
  onPreviousWeek?: () => void;
  onNextWeek?: () => void;
}

export function TimesheetGrid({
  employeeId,
  weekStartDate,
  capacityHours,
  onPreviousWeek,
  onNextWeek,
}: TimesheetGridProps) {
  const queryClient = useQueryClient();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [isDirty, setIsDirty] = useState(false);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(weekStartDate, i)),
    [weekStartDate]
  );

  const startDateStr = format(weekDays[0], "yyyy-MM-dd");
  const endDateStr   = format(weekDays[6], "yyyy-MM-dd");

  const { data: projects } = useListProjects(
    { includeInactive: false },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) } }
  );

  const { data: timeEntries, isLoading: entriesLoading } = useListTimeEntries(
    { employeeId, startDate: startDateStr, endDate: endDateStr },
    {
      query: {
        queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
        enabled: !!employeeId,
      },
    }
  );

  const bulkUpsert = useBulkUpsertTimeEntries();

  const [gridData, setGridData] = useState<Record<number, Record<string, string>>>({});
  const [activeProjectIds, setActiveProjectIds] = useState<number[]>([]);

  const initializedForParams = useRef<string | null>(null);
  const currentParamsKey = `${employeeId}-${startDateStr}-${endDateStr}`;

  // Re-initialize grid whenever week / employee changes, or after a fresh load
  useEffect(() => {
    if (timeEntries && projects && initializedForParams.current !== currentParamsKey) {
      initializedForParams.current = currentParamsKey;

      const newGrid: Record<number, Record<string, string>> = {};
      const activeIds = new Set<number>();

      timeEntries.forEach((entry) => {
        if (!newGrid[entry.projectId]) newGrid[entry.projectId] = {};
        newGrid[entry.projectId][entry.entryDate] = entry.hours.toString();
        activeIds.add(entry.projectId);
      });

      setGridData(newGrid);
      setActiveProjectIds(Array.from(activeIds));
      setIsDirty(false);
      setSaveStatus("idle");
    }
  }, [timeEntries, projects, currentParamsKey]);

  // Reset dirty flag when switching weeks (new params key)
  useEffect(() => {
    setIsDirty(false);
    setSaveStatus("idle");
    initializedForParams.current = null;
  }, [currentParamsKey]);

  const handleSave = useCallback(() => {
    if (!isDirty || saveStatus === "saving") return;

    const entriesToSave: { employeeId: number; projectId: number; entryDate: string; hours: number }[] = [];

    for (const projectIdStr in gridData) {
      const projectId = parseInt(projectIdStr, 10);
      for (const date in gridData[projectId]) {
        const hours = parseFloat(gridData[projectId][date]);
        if (!isNaN(hours) && hours >= 0) {
          entriesToSave.push({ employeeId, projectId, entryDate: date, hours });
        }
      }
    }

    setSaveStatus("saving");

    bulkUpsert.mutate(
      { data: { entries: entriesToSave } },
      {
        onSuccess: () => {
          setSaveStatus("saved");
          setIsDirty(false);
          queryClient.invalidateQueries({
            queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
          });
          setTimeout(() => setSaveStatus("idle"), 2500);
        },
        onError: () => {
          setSaveStatus("idle");
        },
      }
    );
  }, [isDirty, saveStatus, gridData, employeeId, bulkUpsert, queryClient, startDateStr, endDateStr]);

  // Ctrl+S shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleCellChange = (projectId: number, date: string, value: string) => {
    if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
    setGridData((prev) => ({
      ...prev,
      [projectId]: { ...(prev[projectId] ?? {}), [date]: value },
    }));
    setIsDirty(true);
    if (saveStatus === "saved") setSaveStatus("idle");
  };

  const handleAddProject = (projectIdStr: string) => {
    const projectId = parseInt(projectIdStr, 10);
    if (!isNaN(projectId) && !activeProjectIds.includes(projectId)) {
      setActiveProjectIds((prev) => [...prev, projectId]);
      setIsDirty(true);
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const move = (r: number, c: number) => {
      const el = document.querySelector(
        `input[data-row="${r}"][data-col="${c}"]`
      ) as HTMLInputElement | null;
      if (el) { e.preventDefault(); el.focus(); }
    };
    if (e.key === "Enter" || e.key === "ArrowDown") move(rowIndex + 1, colIndex);
    else if (e.key === "ArrowUp")    move(rowIndex - 1, colIndex);
    else if (e.key === "ArrowRight") move(rowIndex, colIndex + 1);
    else if (e.key === "ArrowLeft")  move(rowIndex, colIndex - 1);
  };

  // Totals
  const colTotals = weekDays.map((day) => {
    const dateStr = format(day, "yyyy-MM-dd");
    return activeProjectIds.reduce((sum, pId) => {
      const v = parseFloat(gridData[pId]?.[dateStr] || "0");
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
  });

  const rowTotals = activeProjectIds.map((pId) =>
    weekDays.reduce((sum, day) => {
      const v = parseFloat(gridData[pId]?.[format(day, "yyyy-MM-dd")] || "0");
      return sum + (isNaN(v) ? 0 : v);
    }, 0)
  );

  const grandTotal    = colTotals.reduce((a, b) => a + b, 0);
  const isOverCapacity = grandTotal > capacityHours;

  if (entriesLoading && !initializedForParams.current) {
    return <div className="p-8 text-center text-muted-foreground">Loading timesheet...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={onPreviousWeek} size="sm">
            &larr; Prev Week
          </Button>
          <div className="font-medium text-sm">
            {format(weekDays[0], "MMM d")} – {format(weekDays[6], "MMM d, yyyy")}
          </div>
          <Button variant="outline" onClick={onNextWeek} size="sm">
            Next Week &rarr;
          </Button>
        </div>

        <div className="flex items-center gap-3">
          {/* Capacity badge */}
          <div
            className={`px-3 py-1.5 rounded-md text-sm font-medium border ${
              isOverCapacity
                ? "bg-destructive/10 text-destructive border-destructive/20"
                : "bg-muted/50 border-border"
            }`}
          >
            {grandTotal.toFixed(1)} / {capacityHours} hrs
          </div>

          {/* Save button */}
          <Button
            onClick={handleSave}
            disabled={!isDirty || saveStatus === "saving"}
            size="sm"
            variant={isDirty ? "default" : "outline"}
            className="min-w-[90px]"
          >
            {saveStatus === "saving" ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>
            ) : saveStatus === "saved" ? (
              <><CheckCircle2 className="h-4 w-4 mr-1.5" /> Saved</>
            ) : (
              <><Save className="h-4 w-4 mr-1.5" /> Save</>
            )}
          </Button>
        </div>
      </div>

      {/* Unsaved-changes hint */}
      {isDirty && (
        <p className="text-xs text-muted-foreground px-1">
          You have unsaved changes — click <strong>Save</strong> or press <kbd className="px-1 py-0.5 rounded border text-xs">Ctrl+S</kbd>
        </p>
      )}

      {/* Grid */}
      <div className="border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[250px]">Project</TableHead>
              {weekDays.map((day) => (
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
              const project = projects?.find((p) => p.id === projectId);
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
                          inputMode="decimal"
                          className="h-9 w-full text-center border-transparent hover:border-input focus:border-ring rounded-sm bg-transparent"
                          value={gridData[projectId]?.[dateStr] ?? ""}
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

            {/* Add-project row / column totals */}
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="p-2">
                <Select onValueChange={handleAddProject}>
                  <SelectTrigger className="h-8 border-dashed bg-transparent w-full">
                    <SelectValue placeholder="+ Add project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects
                      ?.filter((p) => !activeProjectIds.includes(p.id))
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id.toString()}>
                          {p.name} ({p.clientName})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </TableCell>
              {colTotals.map((total, i) => (
                <TableCell key={i} className="text-center font-medium text-muted-foreground">
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
