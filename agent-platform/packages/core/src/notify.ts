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
    input.body,
    input.action ? `Action: ${input.action}` : "",
    ...(input.links ?? []).map((link) => `${link.label}: ${link.url}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatReasonBlock(reasons: string[]): string {
  const cleaned = reasons.map((reason) => reason.trim()).filter(Boolean);
  if (cleaned.length === 0) return "Reasons:\n- No detailed reason was recorded.";
  if (cleaned.length === 1) return `Reason: ${cleaned[0]}`;
  return ["Reasons:", ...cleaned.map((reason) => `- ${reason}`)].join("\n");
}

export function formatDurationMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours}h ${rest}m`;
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
