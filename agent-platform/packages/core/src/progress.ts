import type { Task, TaskRun } from "@agent-platform/shared";
import { findTickets, ticketLabel } from "./agent-chat.js";
import { estimateHours } from "./planning.js";

export interface DoingClock {
  percent: number;
  elapsedMs: number;
  estimateMs: number;
  remainingMs: number;
}

export function doingClock(startedAt: string, hours: number, now: number): DoingClock {
  const estimateMs = Math.max(hours, 0.25) * 3_600_000;
  const started = Date.parse(startedAt);
  const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now));
  const ratio = elapsedMs / estimateMs;
  const percent = ratio <= 0.95 ? Math.round(ratio * 100) : Math.min(99, Math.round(95 + 4 * (1 - Math.exp(-(ratio - 0.95) * 2))));
  return { percent, elapsedMs, estimateMs, remainingMs: Math.max(0, estimateMs - elapsedMs) };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function doingStartedAt(task: Pick<Task, "id" | "updatedAt">, runs: Pick<TaskRun, "taskId" | "status" | "startedAt">[]): string {
  const related = runs.filter((run) => run.taskId === task.id && run.startedAt);
  const running = related.filter((run) => run.status === "running");
  const pool = running.length > 0 ? running : related;
  if (pool.length === 0) return task.updatedAt;
  return [...pool].sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0]!.startedAt;
}

export function describeDoingProgress(task: Task, startedAt: string, now: Date): string {
  const hours = estimateHours(task);
  const clock = doingClock(startedAt, hours, now.getTime());
  const estimate = formatDuration(clock.estimateMs);
  const remaining = clock.remainingMs > 0
    ? `About ${formatDuration(clock.remainingMs)} left of a ${estimate} estimate.`
    : `Past the ${estimate} estimate, still working.`;
  return [
    ticketLabel(task),
    `${clock.percent}% of 100%`,
    `In progress for ${formatDuration(clock.elapsedMs)}.`,
    remaining,
  ].join("\n");
}

const STAGE_LABEL: Record<string, string> = {
  backlog: "Backlog",
  planning: "Planning",
  todo: "To Do",
  doing: "Doing",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
};

export function describeProgress(tasks: Task[], runs: Pick<TaskRun, "taskId" | "status" | "startedAt">[], query: string, now: Date): string {
  const doing = tasks.filter((task) => task.stage === "doing");
  const pool = query ? findTickets(tasks, query) : doing;
  if (query && pool.length === 0) return `Ticket ${query} was not found.`;
  if (query && pool.length > 1) return `Several tickets match “${query}”: ${pool.map((task) => ticketLabel(task)).join(", ")}. Name one of them.`;
  if (pool.length === 0) return "Nothing is in Doing.";
  return pool.map((task) => {
    if (task.stage !== "doing") return `${ticketLabel(task)} is in ${STAGE_LABEL[task.stage] ?? task.stage}, not in progress.`;
    return describeDoingProgress(task, doingStartedAt(task, runs), now);
  }).join("\n\n");
}
