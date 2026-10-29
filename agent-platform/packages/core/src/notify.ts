import type { Severity } from "@agent-platform/shared";

export interface NotificationDraft {
  agentName: string;
  repository: string;
  taskTitle?: string;
  status: string;
  severity: Severity;
  title: string;
  action?: string;
  body: string;
  links?: { label: string; url: string }[];
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, urgent: 2 };

export function formatNotification(input: NotificationDraft): string {
  const lines = [
    `[${input.severity}] ${input.agentName}`,
    `Repo: ${input.repository || "unassigned"}`,
    `Task: ${input.taskTitle || "n/a"}`,
    `Status: ${input.status}`,
    input.action ? `Action: ${input.action}` : "",
    input.body,
    ...(input.links ?? []).map((link) => `${link.label}: ${link.url}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export function shouldSendImmediately(severity: Severity, minimum: Severity): boolean {
  return RANK[severity] >= RANK[minimum] && severity !== "info";
}

export function parseTelegramCommand(text: string): { command: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [command, ...rest] = trimmed.split(/\s+/);
  return { command: (command ?? "").split("@")[0]!.toLowerCase(), arg: rest.join(" ").trim() };
}
