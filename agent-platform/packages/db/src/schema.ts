import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AgentRules, ColumnMap, SelectionRules } from "@agent-platform/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  hint: text("hint").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  repositoryUrl: text("repository_url").notNull(),
  repositoryName: text("repository_name").notNull(),
  linkedRepositories: jsonb("linked_repositories").$type<string[]>().notNull(),
  defaultBranch: text("default_branch").notNull(),
  provider: text("provider").notNull(),
  boardId: text("board_id").notNull(),
  boardName: text("board_name").notNull(),
  workspacePath: text("workspace_path").notNull(),
  executorKind: text("executor_kind").notNull(),
  dailyCapacityHours: doublePrecision("daily_capacity_hours").notNull(),
  allowOverCapacity: boolean("allow_over_capacity").notNull(),
  credentialSecretId: uuid("credential_secret_id"),
  telegramChatId: text("telegram_chat_id").notNull(),
  rules: jsonb("rules").$type<AgentRules>().notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  name: text("name").notNull(),
  columns: jsonb("columns").$type<ColumnMap>().notNull(),
  selection: jsonb("selection").$type<SelectionRules>().notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteria: text("acceptance_criteria").notNull(),
  comments: jsonb("comments").$type<string[]>().notNull(),
  url: text("url").notNull(),
  stage: text("stage").notNull(),
  priority: integer("priority").notNull(),
  estimateHours: doublePrecision("estimate_hours"),
  dependsOn: jsonb("depends_on").$type<string[]>().notNull(),
  dueAt: ts("due_at"),
  plan: text("plan").notNull(),
  branchName: text("branch_name").notNull(),
  prUrl: text("pr_url").notNull(),
  blockedReason: text("blocked_reason").notNull(),
  exceptionNote: text("exception_note").notNull(),
  checksPassed: boolean("checks_passed").notNull(),
  labels: jsonb("labels").$type<string[]>().notNull(),
  boardPosition: doublePrecision("board_position").notNull().default(0),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const taskRuns = pgTable("task_runs", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  executorId: text("executor_id").notNull(),
  status: text("status").notNull(),
  activity: text("activity").notNull(),
  modelId: text("model_id").notNull(),
  costClass: text("cost_class").notNull(),
  summary: text("summary").notNull(),
  error: text("error").notNull(),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  startedAt: ts("started_at").notNull(),
  finishedAt: ts("finished_at"),
});

export const taskEvents = pgTable("task_events", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  taskId: uuid("task_id"),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull(),
});

export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").primaryKey(),
  taskRunId: uuid("task_run_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  step: integer("step").notNull(),
  note: text("note").notNull(),
  ownedFiles: jsonb("owned_files").$type<string[]>().notNull(),
  createdAt: ts("created_at").notNull(),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  source: text("source").notNull(),
  decision: text("decision").notNull(),
  actor: text("actor").notNull(),
  comment: text("comment").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceRefs: jsonb("source_refs").$type<string[]>().notNull(),
  revision: integer("revision").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const memoryRevisions = pgTable("memory_revisions", {
  id: uuid("id").primaryKey(),
  memoryId: uuid("memory_id").notNull(),
  revision: integer("revision").notNull(),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const providers = pgTable("providers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  baseUrl: text("base_url").notNull(),
  costClass: text("cost_class").notNull(),
  enabled: boolean("enabled").notNull(),
  secretId: uuid("secret_id"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const models = pgTable("models", {
  id: uuid("id").primaryKey(),
  providerId: uuid("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  displayName: text("display_name").notNull(),
  costClass: text("cost_class").notNull(),
  enabled: boolean("enabled").notNull(),
  parameters: jsonb("parameters").$type<Record<string, string | number | boolean>>().notNull(),
  createdAt: ts("created_at").notNull(),
});

export const modelAssignments = pgTable("model_assignments", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id"),
  activity: text("activity").notNull(),
  modelId: uuid("model_id").notNull(),
  fallbackModelId: uuid("fallback_model_id"),
  maxTokens: integer("max_tokens").notNull(),
  dailyTokenBudget: integer("daily_token_budget"),
  allowLocalOnly: boolean("allow_local_only").notNull(),
  requirePaid: boolean("require_paid").notNull(),
});

export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id"),
  modelId: text("model_id").notNull(),
  activity: text("activity").notNull(),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  costClass: text("cost_class").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const telegramConfig = pgTable("telegram_config", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull(),
  botSecretId: uuid("bot_secret_id"),
  chatId: text("chat_id").notNull(),
  minSeverity: text("min_severity").notNull(),
  digestMinutes: integer("digest_minutes").notNull(),
  lastDigestAt: ts("last_digest_at"),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id"),
  taskId: uuid("task_id"),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  links: jsonb("links").$type<{ label: string; url: string }[]>().notNull(),
  delivered: boolean("delivered").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: ts("created_at").notNull(),
});

export const schedulerState = pgTable("scheduler_state", {
  agentId: uuid("agent_id").primaryKey(),
  lastPlanAt: ts("last_plan_at"),
  lastTickAt: ts("last_tick_at"),
  activeRunId: uuid("active_run_id"),
  retryAt: ts("retry_at"),
  consecutiveFailures: integer("consecutive_failures").notNull(),
});

export const heartbeats = pgTable("heartbeats", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  updatedAt: ts("updated_at").notNull(),
});
