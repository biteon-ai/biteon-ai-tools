import { desc, eq, gte, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type {
  Agent,
  Approval,
  AuditLog,
  Checkpoint,
  Heartbeat,
  Memory,
  ModelAssignment,
  ModelRecord,
  NotificationRecord,
  ProviderRecord,
  SchedulerState,
  StoredSecret,
  Task,
  TaskEvent,
  TaskRun,
  TelegramConfig,
  UsageEntry,
  Workflow,
} from "@agent-platform/shared";
import * as schema from "./schema.js";
import type { PlatformStore, UserRecord } from "./store.js";

const date = (value: string): Date => new Date(value);
const dateOrNull = (value: string | null): Date | null => (value ? new Date(value) : null);
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const isoOrNull = (value: Date | string | null): string | null => (value ? iso(value) : null);

export class PostgresStore implements PlatformStore {
  private readonly db: PostgresJsDatabase<typeof schema>;
  private readonly sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10 });
    this.db = drizzle(this.sql, { schema });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async ping(): Promise<boolean> {
    const rows = await this.sql`SELECT 1 as ok`;
    return rows.length === 1;
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.select().from(schema.users);
    return rows.length;
  }

  async createUser(user: UserRecord): Promise<UserRecord> {
    await this.db.insert(schema.users).values({ ...user, email: user.email.toLowerCase(), createdAt: date(user.createdAt) });
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
    const row = rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.passwordHash, createdAt: iso(row.createdAt) } : null;
  }

  async listAgents(): Promise<Agent[]> {
    return (await this.db.select().from(schema.agents)).map(mapAgent);
  }
  async getAgent(id: string): Promise<Agent | null> {
    const rows = await this.db.select().from(schema.agents).where(eq(schema.agents.id, id));
    return rows[0] ? mapAgent(rows[0]) : null;
  }
  async insertAgent(agent: Agent): Promise<Agent> {
    await this.db.insert(schema.agents).values(agentToRow(agent));
    return agent;
  }
  async updateAgent(agent: Agent): Promise<Agent> {
    await this.db.update(schema.agents).set(agentToRow(agent)).where(eq(schema.agents.id, agent.id));
    return agent;
  }
  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(schema.agents).where(eq(schema.agents.id, id));
  }
  async getWorkflow(agentId: string): Promise<Workflow | null> {
    const rows = await this.db.select().from(schema.workflows).where(eq(schema.workflows.agentId, agentId));
    return rows[0] ? mapWorkflow(rows[0]) : null;
  }
  async saveWorkflow(workflow: Workflow): Promise<Workflow> {
    const existing = await this.getWorkflow(workflow.agentId);
    const row = {
      ...workflow,
      createdAt: date(workflow.createdAt),
      updatedAt: date(workflow.updatedAt),
    };
    if (!existing) await this.db.insert(schema.workflows).values(row);
    else await this.db.update(schema.workflows).set(row).where(eq(schema.workflows.agentId, workflow.agentId));
    return workflow;
  }
  async listTasks(agentId?: string): Promise<Task[]> {
    const rows = agentId
      ? await this.db.select().from(schema.tasks).where(eq(schema.tasks.agentId, agentId))
      : await this.db.select().from(schema.tasks);
    return rows.map(mapTask);
  }
  async getTask(id: string): Promise<Task | null> {
    const rows = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    return rows[0] ? mapTask(rows[0]) : null;
  }
  async saveTask(task: Task): Promise<Task> {
    const existing = await this.getTask(task.id);
    if (!existing) await this.db.insert(schema.tasks).values(taskToRow(task));
    else await this.db.update(schema.tasks).set(taskToRow(task)).where(eq(schema.tasks.id, task.id));
    return task;
  }
  async listRuns(agentId: string): Promise<TaskRun[]> {
    return (await this.db.select().from(schema.taskRuns).where(eq(schema.taskRuns.agentId, agentId))).map(mapRun);
  }
  async findRun(id: string): Promise<TaskRun | null> {
    const rows = await this.db.select().from(schema.taskRuns).where(eq(schema.taskRuns.id, id));
    return rows[0] ? mapRun(rows[0]) : null;
  }
  async createRun(run: TaskRun): Promise<TaskRun> {
    await this.db.insert(schema.taskRuns).values(runToRow(run));
    return run;
  }
  async updateRun(run: TaskRun): Promise<TaskRun> {
    await this.db.update(schema.taskRuns).set(runToRow(run)).where(eq(schema.taskRuns.id, run.id));
    return run;
  }
  async addEvent(event: TaskEvent): Promise<TaskEvent> {
    await this.db.insert(schema.taskEvents).values({ ...event, createdAt: date(event.createdAt) });
    return event;
  }
  async listEvents(agentId?: string, limit = 50): Promise<TaskEvent[]> {
    const query = this.db.select().from(schema.taskEvents).orderBy(desc(schema.taskEvents.createdAt)).limit(limit);
    const rows = agentId ? await query.where(eq(schema.taskEvents.agentId, agentId)) : await query;
    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }
  async saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    await this.db.insert(schema.checkpoints).values({ ...checkpoint, createdAt: date(checkpoint.createdAt) });
    return checkpoint;
  }
  async latestCheckpoint(taskRunId: string): Promise<Checkpoint | null> {
    const rows = await this.db
      .select()
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.taskRunId, taskRunId))
      .orderBy(desc(schema.checkpoints.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? { ...row, createdAt: iso(row.createdAt) } : null;
  }
  async createApproval(approval: Approval): Promise<Approval> {
    await this.db.insert(schema.approvals).values({
      ...approval,
      createdAt: date(approval.createdAt),
    });
    return approval;
  }
  async latestApproval(taskId: string): Promise<Approval | null> {
    const rows = await this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.taskId, taskId))
      .orderBy(desc(schema.approvals.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...row, source: row.source as Approval["source"], decision: row.decision as Approval["decision"], createdAt: iso(row.createdAt) };
  }
  async listMemories(agentId: string): Promise<Memory[]> {
    const rows = await this.db.select().from(schema.memories).where(eq(schema.memories.agentId, agentId));
    return rows.map((row) => ({ ...row, kind: row.kind as Memory["kind"], createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }));
  }
  async createMemory(memory: Memory): Promise<Memory> {
    await this.db.insert(schema.memories).values({ ...memory, createdAt: date(memory.createdAt), updatedAt: date(memory.updatedAt) });
    await this.db.insert(schema.memoryRevisions).values({
      id: crypto.randomUUID(),
      memoryId: memory.id,
      revision: memory.revision,
      body: memory.body,
      createdAt: date(memory.updatedAt),
    });
    return memory;
  }
  async reviseMemory(memory: Memory): Promise<Memory> {
    await this.db.update(schema.memories).set({
      ...memory,
      createdAt: date(memory.createdAt),
      updatedAt: date(memory.updatedAt),
    }).where(eq(schema.memories.id, memory.id));
    await this.db.insert(schema.memoryRevisions).values({
      id: crypto.randomUUID(),
      memoryId: memory.id,
      revision: memory.revision,
      body: memory.body,
      createdAt: date(memory.updatedAt),
    });
    return memory;
  }
  async deleteMemory(id: string): Promise<void> {
    await this.db.delete(schema.memories).where(eq(schema.memories.id, id));
  }
  async listProviders(): Promise<ProviderRecord[]> {
    return (await this.db.select().from(schema.providers)).map(mapProvider);
  }
  async getProvider(id: string): Promise<ProviderRecord | null> {
    const rows = await this.db.select().from(schema.providers).where(eq(schema.providers.id, id));
    return rows[0] ? mapProvider(rows[0]) : null;
  }
  async insertProvider(provider: ProviderRecord): Promise<ProviderRecord> {
    await this.db.insert(schema.providers).values(providerToRow(provider));
    return provider;
  }
  async updateProvider(provider: ProviderRecord): Promise<ProviderRecord> {
    await this.db.update(schema.providers).set(providerToRow(provider)).where(eq(schema.providers.id, provider.id));
    return provider;
  }
  async deleteProvider(id: string): Promise<void> {
    const owned = await this.db.select().from(schema.models).where(eq(schema.models.providerId, id));
    const ids = owned.map((model) => model.id);
    if (ids.length > 0) {
      await this.db.update(schema.modelAssignments).set({ fallbackModelId: null }).where(inArray(schema.modelAssignments.fallbackModelId, ids));
      await this.db.delete(schema.modelAssignments).where(inArray(schema.modelAssignments.modelId, ids));
    }
    await this.db.delete(schema.providers).where(eq(schema.providers.id, id));
  }
  async listModels(): Promise<ModelRecord[]> {
    return (await this.db.select().from(schema.models)).map(mapModel);
  }
  async getModel(id: string): Promise<ModelRecord | null> {
    const rows = await this.db.select().from(schema.models).where(eq(schema.models.id, id));
    return rows[0] ? mapModel(rows[0]) : null;
  }
  async insertModel(model: ModelRecord): Promise<ModelRecord> {
    await this.db.insert(schema.models).values({ ...model, createdAt: date(model.createdAt) });
    return model;
  }
  async updateModel(model: ModelRecord): Promise<ModelRecord> {
    await this.db.update(schema.models).set({ ...model, createdAt: date(model.createdAt) }).where(eq(schema.models.id, model.id));
    return model;
  }
  async listAssignments(): Promise<ModelAssignment[]> {
    const rows = await this.db.select().from(schema.modelAssignments);
    return rows.map((row) => ({ ...row, activity: row.activity as ModelAssignment["activity"] }));
  }
  async saveAssignment(assignment: ModelAssignment): Promise<ModelAssignment> {
    const rows = await this.db.select().from(schema.modelAssignments);
    const existing = rows.find((row) => row.activity === assignment.activity && row.agentId === assignment.agentId);
    if (!existing) await this.db.insert(schema.modelAssignments).values(assignment);
    else await this.db.update(schema.modelAssignments).set(assignment).where(eq(schema.modelAssignments.id, existing.id));
    return assignment;
  }
  async addUsage(entry: UsageEntry): Promise<void> {
    await this.db.insert(schema.usageLedger).values({ ...entry, createdAt: date(entry.createdAt) });
  }
  async usageSince(isoDate: string): Promise<UsageEntry[]> {
    const rows = await this.db.select().from(schema.usageLedger).where(gte(schema.usageLedger.createdAt, date(isoDate)));
    return rows.map((row) => ({
      ...row,
      activity: row.activity as UsageEntry["activity"],
      costClass: row.costClass as UsageEntry["costClass"],
      createdAt: iso(row.createdAt),
    }));
  }
  async putSecret(secret: StoredSecret): Promise<StoredSecret> {
    const existing = await this.getSecret(secret.id);
    const row = { ...secret, createdAt: date(secret.createdAt), updatedAt: date(secret.updatedAt) };
    if (!existing) await this.db.insert(schema.secrets).values(row);
    else await this.db.update(schema.secrets).set(row).where(eq(schema.secrets.id, secret.id));
    return secret;
  }
  async getSecret(id: string): Promise<StoredSecret | null> {
    const rows = await this.db.select().from(schema.secrets).where(eq(schema.secrets.id, id));
    const row = rows[0];
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }
  async getTelegramConfig(): Promise<TelegramConfig | null> {
    const rows = await this.db.select().from(schema.telegramConfig).where(eq(schema.telegramConfig.id, "default"));
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: row.enabled,
      botSecretId: row.botSecretId,
      chatId: row.chatId,
      minSeverity: row.minSeverity as TelegramConfig["minSeverity"],
      digestMinutes: row.digestMinutes,
      lastDigestAt: isoOrNull(row.lastDigestAt),
    };
  }
  async saveTelegramConfig(config: TelegramConfig): Promise<TelegramConfig> {
    const row = {
      id: "default",
      enabled: config.enabled,
      botSecretId: config.botSecretId,
      chatId: config.chatId,
      minSeverity: config.minSeverity,
      digestMinutes: config.digestMinutes,
      lastDigestAt: dateOrNull(config.lastDigestAt),
    };
    const existing = await this.getTelegramConfig();
    if (!existing) await this.db.insert(schema.telegramConfig).values(row);
    else await this.db.update(schema.telegramConfig).set(row).where(eq(schema.telegramConfig.id, "default"));
    return config;
  }
  async addNotification(notification: NotificationRecord): Promise<NotificationRecord> {
    await this.db.insert(schema.notifications).values({ ...notification, createdAt: date(notification.createdAt) });
    return notification;
  }
  async listNotifications(limit = 50): Promise<NotificationRecord[]> {
    const rows = await this.db.select().from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).limit(limit);
    return rows.map(mapNotification);
  }
  async listUndelivered(): Promise<NotificationRecord[]> {
    const rows = await this.db.select().from(schema.notifications).where(eq(schema.notifications.delivered, false));
    return rows.map(mapNotification);
  }
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(schema.notifications).set({ delivered: true }).where(inArray(schema.notifications.id, ids));
  }
  async addAudit(entry: AuditLog): Promise<void> {
    await this.db.insert(schema.auditLogs).values({ ...entry, createdAt: date(entry.createdAt) });
  }
  async listAudit(limit = 50): Promise<AuditLog[]> {
    const rows = await this.db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(limit);
    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }
  async getScheduler(agentId: string): Promise<SchedulerState | null> {
    const rows = await this.db.select().from(schema.schedulerState).where(eq(schema.schedulerState.agentId, agentId));
    const row = rows[0];
    if (!row) return null;
    return {
      agentId: row.agentId,
      lastPlanAt: isoOrNull(row.lastPlanAt),
      lastTickAt: isoOrNull(row.lastTickAt),
      activeRunId: row.activeRunId,
      retryAt: isoOrNull(row.retryAt),
      consecutiveFailures: row.consecutiveFailures,
    };
  }
  async saveScheduler(state: SchedulerState): Promise<SchedulerState> {
    const row = {
      agentId: state.agentId,
      lastPlanAt: dateOrNull(state.lastPlanAt),
      lastTickAt: dateOrNull(state.lastTickAt),
      activeRunId: state.activeRunId,
      retryAt: dateOrNull(state.retryAt),
      consecutiveFailures: state.consecutiveFailures,
    };
    const existing = await this.getScheduler(state.agentId);
    if (!existing) await this.db.insert(schema.schedulerState).values(row);
    else await this.db.update(schema.schedulerState).set(row).where(eq(schema.schedulerState.agentId, state.agentId));
    return state;
  }
  async saveHeartbeat(heartbeat: Heartbeat): Promise<void> {
    const existing = await this.getHeartbeat(heartbeat.id);
    const row = { id: heartbeat.id, payload: heartbeat.payload, updatedAt: date(heartbeat.updatedAt) };
    if (!existing) await this.db.insert(schema.heartbeats).values(row);
    else await this.db.update(schema.heartbeats).set(row).where(eq(schema.heartbeats.id, heartbeat.id));
  }
  async getHeartbeat(id: string): Promise<Heartbeat | null> {
    const rows = await this.db.select().from(schema.heartbeats).where(eq(schema.heartbeats.id, id));
    const row = rows[0];
    return row ? { id: row.id, payload: row.payload, updatedAt: iso(row.updatedAt) } : null;
  }
}

function agentToRow(agent: Agent) {
  return { ...agent, createdAt: date(agent.createdAt), updatedAt: date(agent.updatedAt) };
}
function mapAgent(row: typeof schema.agents.$inferSelect): Agent {
  return {
    ...row,
    status: row.status as Agent["status"],
    provider: row.provider as Agent["provider"],
    executorKind: row.executorKind as Agent["executorKind"],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
function mapWorkflow(row: typeof schema.workflows.$inferSelect): Workflow {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}
function taskToRow(task: Task) {
  return {
    ...task,
    boardPosition: task.boardPosition ?? 0,
    dueAt: dateOrNull(task.dueAt),
    createdAt: date(task.createdAt),
    updatedAt: date(task.updatedAt),
  };
}
function mapTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    ...row,
    stage: row.stage as Task["stage"],
    dueAt: isoOrNull(row.dueAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
function runToRow(run: TaskRun) {
  return { ...run, startedAt: date(run.startedAt), finishedAt: dateOrNull(run.finishedAt) };
}
function mapRun(row: typeof schema.taskRuns.$inferSelect): TaskRun {
  return {
    ...row,
    status: row.status as TaskRun["status"],
    activity: row.activity as TaskRun["activity"],
    costClass: row.costClass as TaskRun["costClass"],
    startedAt: iso(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}
function providerToRow(provider: ProviderRecord) {
  return { ...provider, createdAt: date(provider.createdAt), updatedAt: date(provider.updatedAt) };
}
function mapProvider(row: typeof schema.providers.$inferSelect): ProviderRecord {
  return {
    ...row,
    type: row.type as ProviderRecord["type"],
    costClass: row.costClass as ProviderRecord["costClass"],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
function mapModel(row: typeof schema.models.$inferSelect): ModelRecord {
  return {
    ...row,
    costClass: row.costClass as ModelRecord["costClass"],
    createdAt: iso(row.createdAt),
  };
}
function mapNotification(row: typeof schema.notifications.$inferSelect): NotificationRecord {
  return {
    ...row,
    severity: row.severity as NotificationRecord["severity"],
    createdAt: iso(row.createdAt),
  };
}
