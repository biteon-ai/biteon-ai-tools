import type { ColumnMap, Stage, Task } from "@agent-platform/shared";
import { startOfAppDay } from "./timezone.js";

export function estimateHours(task: Pick<Task, "description" | "acceptanceCriteria" | "estimateHours">): number {
  if (task.estimateHours && task.estimateHours > 0) return task.estimateHours;
  const words = `${task.description} ${task.acceptanceCriteria}`.trim().split(/\s+/).filter(Boolean).length;
  if (words > 400) return 8;
  if (words > 150) return 4;
  return 2;
}

export function remainingCapacity(dailyHours: number, tasks: Task[], now: Date): number {
  const start = startOfAppDay(now).getTime();
  const used = tasks.reduce((sum, task) => {
    const open = task.stage === "todo" || task.stage === "doing";
    const finishedToday = (task.stage === "review" || task.stage === "done") && Date.parse(task.updatedAt) >= start && !importedBeforeWork(task);
    if (!open && !finishedToday) return sum;
    return sum + estimateHours(task);
  }, 0);
  return Math.max(0, dailyHours - used);
}

function importedBeforeWork(task: Pick<Task, "exceptionNote">): boolean {
  return task.exceptionNote === "Imported as already done on the board." || task.exceptionNote === "Imported from the board while already in review.";
}

function dependenciesDone(task: Task, tasks: Task[]): boolean {
  return task.dependsOn.every((externalId) => tasks.some((candidate) => candidate.externalId === externalId && candidate.stage === "done"));
}

function rank(a: Task, b: Task): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ad = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.createdAt.localeCompare(b.createdAt);
}

export interface CapacitySelection {
  selected: Task[];
  deferred: { task: Task; reason: string }[];
}

export function selectTasksForCapacity(
  candidates: Task[],
  allTasks: Task[],
  remainingHours: number,
  allowOverCapacity: boolean,
  maxTasks: number,
  blockedLabels: string[] = [],
): CapacitySelection {
  const selected: Task[] = [];
  const deferred: CapacitySelection["deferred"] = [];
  let left = remainingHours;
  const ordered = [...candidates].sort(rank);
  for (const task of ordered) {
    if (selected.length >= maxTasks) {
      deferred.push({ task, reason: "daily task limit reached" });
      continue;
    }
    if (task.labels.some((label) => blockedLabels.includes(label))) {
      deferred.push({ task, reason: "blocked label" });
      continue;
    }
    if (!dependenciesDone(task, allTasks)) {
      deferred.push({ task, reason: "dependency is not done" });
      continue;
    }
    const estimate = estimateHours(task);
    if (estimate <= left) {
      selected.push({ ...task, estimateHours: task.estimateHours ?? estimate });
      left -= estimate;
      continue;
    }
    if (allowOverCapacity && selected.length === 0) {
      selected.push({ ...task, estimateHours: task.estimateHours ?? estimate });
      left = 0;
      continue;
    }
    deferred.push({ task, reason: "estimate exceeds remaining capacity" });
  }
  return { selected, deferred };
}

export interface IntakeChoice {
  start: Task | null;
  promote: Task[];
  deferred: { task: Task; reason: string }[];
  detail: string;
}

export function chooseIntake(input: {
  tasks: Task[];
  remainingHours: number;
  allowOverCapacity: boolean;
  maxTasksPerDay: number;
  blockedLabels: string[];
}): IntakeChoice {
  const open = input.tasks.filter((task) => task.stage === "todo" || task.stage === "doing").length;
  const slots = input.maxTasksPerDay <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, input.maxTasksPerDay - open);
  const backlog = input.tasks.filter((task) => task.stage === "backlog");
  const todo = input.tasks.filter((task) => task.stage === "todo").sort(rank);
  if (backlog.length > 0) {
    const selection = selectTasksForCapacity(backlog, input.tasks, input.remainingHours, input.allowOverCapacity, slots, input.blockedLabels);
    if (selection.selected[0]) {
      return { start: selection.selected[0], promote: selection.selected, deferred: selection.deferred, detail: "backlog" };
    }
    if (todo[0]) return { start: todo[0], promote: [], deferred: selection.deferred, detail: "todo" };
    return { start: null, promote: [], deferred: selection.deferred, detail: selection.deferred[0]?.reason ?? "no task fits the remaining capacity" };
  }
  if (todo[0]) return { start: todo[0], promote: [], deferred: [], detail: "todo" };
  const planning = input.tasks.filter((task) => task.stage === "planning");
  const selection = selectTasksForCapacity(planning, input.tasks, input.remainingHours, input.allowOverCapacity, slots, input.blockedLabels);
  if (selection.selected[0]) {
    return { start: selection.selected[0], promote: selection.selected, deferred: selection.deferred, detail: "planning" };
  }
  return { start: null, promote: [], deferred: selection.deferred, detail: selection.deferred[0]?.reason ?? "no task fits the remaining capacity" };
}

export function columnForStage(columns: ColumnMap, stage: Stage): string | null {
  if (stage === "blocked" || stage === "failed") return null;
  const name = columns[stage]?.trim() ?? "";
  return name || null;
}

export function stageForColumn(columns: ColumnMap, columnName: string): Stage | null {
  const needle = normalizeColumn(columnName);
  if (!needle) return null;
  for (const stage of ["backlog", "planning", "todo", "doing", "review", "done"] as const) {
    const name = normalizeColumn(columns[stage] ?? "");
    if (name && name === needle) return stage;
  }
  return null;
}

function normalizeColumn(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "task";
}

export function branchName(pattern: string, task: Pick<Task, "externalId" | "title">): string {
  const name = pattern
    .replaceAll("{task}", slugify(task.externalId))
    .replaceAll("{slug}", slugify(task.title));
  if (name.includes("..") || name.startsWith("/") || name.includes(" ")) {
    throw new Error("branch name is not safe");
  }
  return name;
}

export function backoffMinutes(failures: number): number {
  return Math.min(60, 2 ** Math.max(1, failures));
}
