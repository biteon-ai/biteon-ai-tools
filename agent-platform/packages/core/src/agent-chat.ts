import type { Agent, Task } from "@agent-platform/shared";
import { remainingCapacity } from "./planning.js";
import { transitionTask } from "./workflow.js";

export type AgentCommand =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "shift"; ticket: string }
  | { kind: "unknown" };

export type ProjectIntent =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "about" }
  | { kind: "help" }
  | { kind: "shift"; ticket: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "approve"; ticket: string }
  | { kind: "reject"; ticket: string }
  | { kind: "ticket"; query: string }
  | { kind: "backlog" }
  | { kind: "done" }
  | { kind: "problems" }
  | { kind: "restart" }
  | { kind: "start" }
  | { kind: "push" }
  | { kind: "stop" }
  | { kind: "tick" }
  | { kind: "sync" }
  | { kind: "progress"; query: string }
  | { kind: "tokens" }
  | { kind: "out_of_scope" };

export const PROJECT_HELP = "Commands: list the backlog, what has been done, status, howfar, tokens left, any problems, start, pause, resume, restart, stop, tick, sync, push. Say “commands” for the full list. I only answer about this project.";
export const PROJECT_SCOPE = "I only talk about this project. Say “commands” to see what you can ask.";

function normalizeChat(text: string): string {
  return text.trim().replace(/[?.!]+$/g, "").replace(/\s+/g, " ");
}

function ticketQuery(value: string): string {
  return value.replace(/^(?:the|ticket|on)\s+/i, "").trim();
}

export function interpretProjectChat(text: string): ProjectIntent {
  const normalized = normalizeChat(text);
  const lower = normalized.toLowerCase();
  if (!lower) return { kind: "out_of_scope" };
  if (/^(hi|hello|hey|help|commands|menu|list commands)$/.test(lower)) return { kind: "help" };
  if (/^(?:\/)?tokens$/.test(lower) || (/\btokens?\b/.test(lower) && /\b(left|remaining|remain|balance|used|usage|limit|many)\b/.test(lower))) return { kind: "tokens" };
  if (/\brestart\b/.test(lower)) return { kind: "restart" };
  if (/\btick\b/.test(lower) && !/\b(ticket|pull request)\b/.test(lower)) return { kind: "tick" };
  if (/\bpush\b/.test(lower) && !/\b(ticket|pull request)\b/.test(lower)) return { kind: "push" };
  if (/\bsync\b/.test(lower) || /\brefresh(?: the)? (?:board|tickets)\b/.test(lower)) return { kind: "sync" };
  if (/\bstop working\b/.test(lower)) return { kind: "pause" };
  if (/\bstop\b/.test(lower)) return { kind: "stop" };
  if (/\bstart\b/.test(lower) && !/\bstart working on\b/.test(lower) && !/\bstart again\b/.test(lower)) return { kind: "start" };
  if (/\b(problem|problems|wrong|stuck|blocked|failed)\b/.test(lower)) return { kind: "problems" };
  if (/\b(been done|completed work|finished work)\b/.test(lower) || /^(?:what(?:'s| is| has) been done|list done|show done|done|completed|finished)$/.test(lower) || (/\b(list|show|what)\b/.test(lower) && /\b(done|completed|finished)\b/.test(lower))) return { kind: "done" };
  if (/\bbacklog\b/.test(lower)) return { kind: "backlog" };
  const far = lower.match(/^(?:\/)?how\s*far(?:\s+(?:is|on|with|for))?\s*(.*)$/) ?? (/\bhowfar\b/.test(lower) ? ["", ""] : null);
  if (far) return { kind: "progress", query: ticketQuery(far[1] ?? "") };
  if (/^how long$/.test(lower) || (/\bhow long\b/.test(lower) && /\b(progress|doing|ticket|working|running|taking)\b/.test(lower))) return { kind: "progress", query: "" };
  const decision = lower.match(/^(approve|accept|reject|decline)(?:\s+(?:ticket\s+)?#?\s*(.+))?$/);
  if (decision) {
    const kind = decision[1] === "approve" || decision[1] === "accept" ? "approve" : "reject";
    return { kind, ticket: ticketQuery(decision[2] ?? "") };
  }
  const shift = normalized.match(/^(?:please\s+)?(?:work on|start working on|switch to|shift to|move to|focus on|redirect to|take)\s+(?:ticket\s+)?#?\s*(.+)$/i);
  if (shift?.[1]) return { kind: "shift", ticket: ticketQuery(shift[1]) };
  const aboutTicket = normalized.match(/^(?:tell me about|what about|info on|details for|status of)\s+(?:ticket\s+)?#?\s*(.+)$/i);
  if (aboutTicket?.[1] && !/^(?:the\s+)?(?:repo|repository|project|board|branch)$/i.test(aboutTicket[1].trim())) return { kind: "ticket", query: ticketQuery(aboutTicket[1]) };
  if (!/^(?:please\s+)?(?:work on|start working on|switch to|shift to|move to|focus on|redirect to|take)\b/i.test(normalized)) {
    if (/\b(pause|hold on|stop working)\b/.test(lower)) return { kind: "pause" };
    if (/\b(resume|unpause|start again|keep going)\b/.test(lower) || /^continue$/.test(lower)) return { kind: "resume" };
  }
  if (/^(what are you working on|what are you doing|what(?:'s| is) happening|what(?:'s| is) going on|status|what is the status|what(?:'s| is) the status|progress|current task|how(?:'s| is) it going|what are you up to)$/.test(lower)
    || /^what(?:'s| is| are).{0,48}\b(doing|working on|up to)\b/.test(lower)) return { kind: "status" };
  if (/\b(list|show)\b/.test(lower) && /\b(tickets|tasks|backlog|queue|board)\b/.test(lower)) return { kind: "list" };
  if (/\b(what|which|any)\b/.test(lower) && /\b(tickets|tasks|backlog)\b/.test(lower)) return { kind: "list" };
  if (/\b(which|what)\b/.test(lower) && /\b(repo|repository|project|board|branch)\b/.test(lower)) return { kind: "about" };
  if (/^(repo|repository|project info|about|about the project)$/.test(lower)) return { kind: "about" };
  return { kind: "out_of_scope" };
}

export function parseAgentCommand(text: string): AgentCommand {
  const intent = interpretProjectChat(text);
  if (intent.kind === "status") return { kind: "status" };
  if (intent.kind === "list") return { kind: "list" };
  if (intent.kind === "shift") return { kind: "shift", ticket: intent.ticket };
  return { kind: "unknown" };
}

export function describeAgentStatus(tasks: Task[], dailyHours: number, now: Date): string {
  const doing = tasks.filter((task) => task.stage === "doing");
  const backlog = tasks.filter((task) => task.stage === "backlog");
  const remaining = remainingCapacity(dailyHours, tasks, now);
  const capacity = `${remaining}h of the ${dailyHours}h daily capacity remains.`;
  const waiting = `${backlog.length} ticket${backlog.length === 1 ? "" : "s"} in Backlog.`;
  if (doing.length === 0) return `Nothing is in progress. ${waiting} ${capacity}`;
  const current = doing.map((task) => `#${task.externalId} ${task.title}`).join(", ");
  return `Working on ${current}. ${waiting} ${capacity}`;
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

export function describeColumn(tasks: Task[], stage: string, limit = 20): string {
  const label = STAGE_LABEL[stage] ?? stage;
  const rows = tasks.filter((task) => task.stage === stage).sort((left, right) => {
    const leftPosition = Number.isFinite(left.boardPosition) ? left.boardPosition ?? 0 : Number.MAX_SAFE_INTEGER;
    const rightPosition = Number.isFinite(right.boardPosition) ? right.boardPosition ?? 0 : Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || left.title.localeCompare(right.title);
  });
  if (rows.length === 0) return `No tickets in ${label}.`;
  const shown = rows.slice(0, limit).map((task) => `#${task.externalId} ${task.title}`).join("\n");
  const rest = rows.length - limit;
  return `${label} (${rows.length})\n${shown}${rest > 0 ? `\n…and ${rest} more.` : ""}`;
}

export function describeProblems(agent: Pick<Agent, "name" | "status">, tasks: Task[]): string {
  const attention = tasks.filter((task) => task.stage === "blocked" || task.stage === "failed" || Boolean(task.blockedReason));
  const review = tasks.filter((task) => task.stage === "review");
  const lines = [`${agent.name} [${agent.status}]`];
  if (agent.status !== "running") lines.push(`The agent is ${agent.status}. Say “restart ${agent.name}” to run it again.`);
  lines.push(attention.length === 0 ? "No blocked or failed tickets." : attention.slice(0, 15).map((task) => `#${task.externalId} ${task.title} — ${task.stage}${task.blockedReason ? `: ${task.blockedReason}` : ""}`).join("\n"));
  if (review.length > 0) lines.push(`${review.length} ticket${review.length === 1 ? " is" : "s are"} waiting in Review.`);
  return lines.join("\n");
}

export function describeTickets(tasks: Task[]): string {
  if (tasks.length === 0) return "No tickets.";
  const stages = ["doing", "backlog", "todo", "planning", "review", "blocked", "failed", "done"];
  const known = new Set(stages);
  const extra = [...new Set(tasks.map((task) => task.stage).filter((stage) => !known.has(stage)))];
  return [...stages, ...extra].map((stage) => describeColumn(tasks, stage, stage === "done" ? 8 : 15)).filter((line) => !line.startsWith("No tickets")).join("\n\n");
}

export function findTickets(tasks: Task[], query: string): Task[] {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  if (!needle) return [];
  const exact = tasks.filter((task) => task.externalId.toLowerCase() === needle || task.id.toLowerCase() === needle || task.title.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  const prefix = tasks.filter((task) => task.id.toLowerCase().startsWith(needle));
  if (prefix.length > 0) return prefix;
  if (needle.length < 3) return [];
  return tasks.filter((task) => task.title.toLowerCase().includes(needle) || task.externalId.toLowerCase().includes(needle));
}

export function resolveTicket(tasks: Task[], query: string): Task | null {
  const matches = findTickets(tasks, query);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function describeProject(agent: Pick<Agent, "name" | "status" | "repositoryName" | "boardName" | "defaultBranch" | "dailyCapacityHours">, tasks: Task[], now: Date): string {
  return [
    `${agent.name} [${agent.status}]`,
    `Repo: ${agent.repositoryName || "unassigned"}`,
    agent.boardName ? `Board: ${agent.boardName}` : "",
    `Branch: ${agent.defaultBranch || "develop"}`,
    describeAgentStatus(tasks, agent.dailyCapacityHours, now),
    describeProblems(agent, tasks).split("\n").slice(1).join("\n"),
  ].filter(Boolean).join("\n");
}

export function describeTicket(task: Task): string {
  return [
    `#${task.externalId} ${task.title}`,
    `Stage: ${task.stage}`,
    task.blockedReason ? `Blocked: ${task.blockedReason}` : "",
    task.prUrl ? `Pull request: ${task.prUrl}` : "",
    task.description ? task.description.slice(0, 500) : "",
  ].filter(Boolean).join("\n");
}

export function scopeMemoryBody(task: Pick<Task, "title" | "description" | "acceptanceCriteria" | "branchName">, phase: "start" | "review" | "failed", note: string): string {
  const scope = task.acceptanceCriteria.trim() || task.description.trim() || "Implement only what this ticket asks.";
  const lines = [
    `Stay on ticket “${task.title}”.`,
    `Scope: ${scope}`,
    task.branchName ? `Branch: ${task.branchName}` : "",
  ];
  if (phase === "start") lines.push("The build is in progress. Continue this ticket only.");
  if (phase === "review") lines.push(`Built and waiting for review. ${note}`.trim(), "Later work must stay inside this ticket unless a new ticket says otherwise.");
  if (phase === "failed") lines.push(`The build stopped inside this ticket. ${note}`.trim(), "The next attempt continues this ticket only.");
  return lines.filter(Boolean).join("\n");
}

export function ticketLabel(task: Task): string {
  return `#${task.externalId} ${task.title}`;
}

export function shiftToTicket(tasks: Task[], target: Task, now: string): { changed: Task[]; reply: string } {
  if (target.stage === "done") {
    return { changed: [], reply: `${ticketLabel(target)} is Done. Done stays behind human approval.` };
  }
  if (target.stage === "doing") {
    return { changed: [], reply: `Already working on ${ticketLabel(target)}.` };
  }
  const changed: Task[] = [];
  const active = tasks.find((task) => task.stage === "doing" && task.id !== target.id);
  if (active) changed.push(transitionTask(active, "todo", { now }));
  let next = target;
  if (next.stage === "backlog") next = transitionTask(next, "planning", { now });
  if (next.stage === "planning") next = transitionTask(next, "todo", { now });
  if (next.stage !== "doing") next = transitionTask(next, "doing", { now });
  changed.push(next);
  return { changed, reply: `Shifted to ${ticketLabel(next)}. It is now in Doing.` };
}

export const UNKNOWN_COMMAND = PROJECT_SCOPE;
