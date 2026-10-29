import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

export const STAGES = [
  "backlog",
  "planning",
  "todo",
  "doing",
  "review",
  "done",
  "blocked",
  "failed",
] as const;
export type Stage = (typeof STAGES)[number];

export const AGENT_STATUSES = ["created", "running", "paused", "stopped", "error"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TASK_PROVIDERS = ["none", "trello", "github_projects"] as const;
export type TaskProvider = (typeof TASK_PROVIDERS)[number];

export const EXECUTORS = ["fake", "llm", "cursor", "codex"] as const;
export type ExecutorKind = (typeof EXECUTORS)[number];

export const COST_CLASSES = ["local", "hosted_free", "paid"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const PROVIDER_TYPES = ["ollama", "openai", "anthropic", "cursor", "codex", "custom"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ACTIVITIES = ["planning", "coding", "testing", "review"] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const MEMORY_KINDS = [
  "architecture",
  "decision",
  "feature",
  "bug",
  "debt",
  "lesson",
  "convention",
  "dependency",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const SEVERITIES = ["info", "warning", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RUN_STATUSES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AGENT_TICK_QUEUE = "agent-ticks";

export interface ColumnMap {
  backlog: string;
  planning: string;
  todo: string;
  doing: string;
  review: string;
  done: string;
}

export const DEFAULT_COLUMNS: ColumnMap = {
  backlog: "Backlog",
  planning: "",
  todo: "To Do",
  doing: "Doing",
  review: "Review",
  done: "Done",
};

export interface SelectionRules {
  priorityLabels: string[];
  blockedLabels: string[];
  maxTasksPerDay: number;
}

export const DEFAULT_SELECTION_RULES: SelectionRules = {
  priorityLabels: [],
  blockedLabels: ["blocked"],
  maxTasksPerDay: 0,
};

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentRules {
  codingStandards: string;
  architecturePrinciples: string;
  testingRequirements: string;
  validationCommands: string[][];
  allowEmptyChecks: boolean;
  branchPattern: string;
  maxRetries: number;
  stallMinutes: number;
  instructions: string;
  skills: Record<string, boolean>;
  customSkills: CustomSkill[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
}

export const SKILLS: SkillDefinition[] = [
  { id: "security-audit", name: "Security audit", description: "Review diffs for common injection, auth, and unsafe execution patterns.", defaultEnabled: true },
  { id: "secrets-scan", name: "Secrets detection", description: "Block review when a diff contains credential material.", defaultEnabled: true },
  { id: "dependency-review", name: "Dependency review", description: "Flag changes to dependency manifests.", defaultEnabled: true },
  { id: "static-analysis", name: "Static analysis", description: "Include project linters and type checks in validation.", defaultEnabled: true },
  { id: "test-generation", name: "Test generation", description: "Ask the executor to add or update tests for the change.", defaultEnabled: true },
  { id: "docs", name: "Documentation", description: "Ask the executor to update docs when behavior changes.", defaultEnabled: false },
  { id: "ui-review", name: "UI review", description: "Ask the executor to check states, layout, and copy for UI changes.", defaultEnabled: false },
  { id: "accessibility", name: "Accessibility", description: "Ask the executor to check names, contrast, and keyboard access.", defaultEnabled: false },
  { id: "performance", name: "Performance", description: "Ask the executor to note obvious hot-path regressions.", defaultEnabled: false },
  { id: "migration-review", name: "Migration review", description: "Flag database migration files for human attention.", defaultEnabled: true },
  { id: "cicd-validation", name: "CI/CD validation", description: "Treat pipeline config changes as review notes.", defaultEnabled: true },
  { id: "threat-model", name: "Threat modeling", description: "Ask the executor to record abuse cases for security-sensitive changes.", defaultEnabled: false },
  { id: "speckit", name: "Speckit", description: "For every ticket, run speckit.constitution, speckit.specify, speckit.clarify, speckit.plan, speckit.tasks, speckit.analyze, speckit.checklist, speckit.implement, and speckit.converge in that order.", defaultEnabled: true },
];

export function skillEnabled(skills: Record<string, boolean> | undefined, id: string): boolean {
  const value = skills?.[id];
  if (typeof value === "boolean") return value;
  return SKILLS.find((skill) => skill.id === id)?.defaultEnabled ?? false;
}

export function defaultRules(): AgentRules {
  return {
    codingStandards: "Follow SOLID where it matches the codebase. Prefer the project's existing patterns. Keep the change scoped to the task. Create one branch per task from the base branch and keep every commit on that branch. Do not commit on develop, main, or master. Resolve conflicts on the task branch before review.",
    architecturePrinciples: "Read the repository and project memory before editing. The repository, tests, and approved docs outrank memory.",
    testingRequirements: "Run the configured validation commands. Add or update tests when behavior changes. Each command must exit 0 before Review. A failing command blocks the pull request. Empty validation is not allowed.",
    validationCommands: [["pnpm", "test"]],
    allowEmptyChecks: false,
    branchPattern: "agent/{task}-{slug}",
    maxRetries: 3,
    stallMinutes: 30,
    instructions: "Before Review, run a Git conflict dry-run against the base branch and stop if it conflicts. Never execute git merge develop. Never auto-merge a pull request. A merge is allowed only after a human approval from the UI or Telegram /approve is stored for the task.",
    skills: Object.fromEntries(SKILLS.map((skill) => [skill.id, skill.defaultEnabled])),
    customSkills: [],
  };
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  repositoryUrl: string;
  repositoryName: string;
  linkedRepositories: string[];
  defaultBranch: string;
  provider: TaskProvider;
  boardId: string;
  boardName: string;
  workspacePath: string;
  executorKind: ExecutorKind;
  dailyCapacityHours: number;
  allowOverCapacity: boolean;
  credentialSecretId: string | null;
  repositorySecretId: string | null;
  telegramChatId: string;
  rules: AgentRules;
  createdAt: string;
  updatedAt: string;
}

export interface Workflow {
  id: string;
  agentId: string;
  name: string;
  columns: ColumnMap;
  selection: SelectionRules;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  agentId: string;
  externalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: string[];
  url: string;
  stage: Stage;
  priority: number;
  estimateHours: number | null;
  dependsOn: string[];
  dueAt: string | null;
  plan: string;
  branchName: string;
  prUrl: string;
  blockedReason: string;
  exceptionNote: string;
  checksPassed: boolean;
  labels: string[];
  boardPosition?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  agentId: string;
  executorId: string;
  status: RunStatus;
  activity: Activity;
  modelId: string;
  costClass: CostClass | "none";
  summary: string;
  error: string;
  tokensIn: number;
  tokensOut: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskEvent {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  taskRunId: string;
  agentId: string;
  step: number;
  note: string;
  ownedFiles: string[];
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  agentId: string;
  source: "ui" | "telegram" | "board" | "import";
  decision: "approved" | "rejected";
  actor: string;
  comment: string;
  createdAt: string;
}

export interface Memory {
  id: string;
  agentId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  sourceRefs: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  costClass: CostClass;
  enabled: boolean;
  secretId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  costClass: CostClass;
  enabled: boolean;
  parameters: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface ModelAssignment {
  id: string;
  agentId: string | null;
  activity: Activity;
  modelId: string;
  fallbackModelId: string | null;
  maxTokens: number;
  dailyTokenBudget: number | null;
  allowLocalOnly: boolean;
  requirePaid: boolean;
}

export interface UsageEntry {
  id: string;
  agentId: string | null;
  modelId: string;
  activity: Activity;
  tokensIn: number;
  tokensOut: number;
  costClass: CostClass;
  createdAt: string;
}

export interface StoredSecret {
  id: string;
  name: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  hint: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botSecretId: string | null;
  chatId: string;
  minSeverity: Severity;
  digestMinutes: number;
  lastDigestAt: string | null;
}

export interface NotificationRecord {
  id: string;
  agentId: string | null;
  taskId: string | null;
  severity: Severity;
  title: string;
  body: string;
  links: { label: string; url: string }[];
  delivered: boolean;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SchedulerState {
  agentId: string;
  lastPlanAt: string | null;
  lastTickAt: string | null;
  activeRunId: string | null;
  retryAt: string | null;
  consecutiveFailures: number;
}

export interface Heartbeat {
  id: string;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface ExternalCard {
  externalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  columnName: string;
  url: string;
  comments: string[];
  labels: string[];
  dueAt: string | null;
  priority: number;
  position?: number;
}

export type ExecutorStatus = "succeeded" | "error" | "cancelled";

export interface ExecutorCheckpoint {
  step: number;
  note: string;
  ownedFiles: string[];
}

export interface ExecutorModel {
  id: string;
  modelId: string;
  costClass: CostClass;
  baseUrl: string;
  apiKey: string;
  providerType: ProviderType;
}

export interface ExecutorRun {
  runId: string;
  agentId: string;
  taskId: string;
  workspaceDir: string;
  prompt: string;
  model: ExecutorModel;
  limits: { timeoutMs: number; maxSteps: number; maxTokens: number };
  checkpoint: ExecutorCheckpoint | null;
}

export interface ExecutorResult {
  status: ExecutorStatus;
  summary: string;
  tokensIn: number;
  tokensOut: number;
  modelId: string;
  costClass: CostClass | "none";
  checkpoint: ExecutorCheckpoint | null;
  error?: string;
}

export interface CodeExecutor {
  id: string;
  capabilities: {
    localModels: boolean;
    gitPush: boolean;
    opensPullRequests: boolean;
    available: boolean;
  };
  run(input: ExecutorRun): Promise<ExecutorResult>;
  cancel(runId: string): Promise<void>;
}

export const EXAMPLE_MASTER_KEY = "local-dev-master-key-change-me-32";

export function defaultAgentName(sourceName: string): string {
  const base = sourceName.trim() || "Project";
  return base.endsWith(" Agent") ? base : `${base} Agent`;
}

export function emptyScheduler(agentId: string): SchedulerState {
  return {
    agentId,
    lastPlanAt: null,
    lastTickAt: null,
    activeRunId: null,
    retryAt: null,
    consecutiveFailures: 0,
  };
}

export function emptyTelegramConfig(): TelegramConfig {
  return {
    enabled: false,
    botSecretId: null,
    chatId: "",
    minSeverity: "warning",
    digestMinutes: 60,
    lastDigestAt: null,
  };
}
