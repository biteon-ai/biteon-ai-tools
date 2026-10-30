import { emptyTelegramConfig } from "@agent-platform/shared";
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
import type { PlatformStore, UserRecord } from "./store.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements PlatformStore {
  users: UserRecord[] = [];
  agents: Agent[] = [];
  workflows: Workflow[] = [];
  tasks: Task[] = [];
  runs: TaskRun[] = [];
  events: TaskEvent[] = [];
  checkpoints: Checkpoint[] = [];
  approvals: Approval[] = [];
  memories: Memory[] = [];
  providers: ProviderRecord[] = [];
  models: ModelRecord[] = [];
  assignments: ModelAssignment[] = [];
  usage: UsageEntry[] = [];
  secrets: StoredSecret[] = [];
  telegram: TelegramConfig = emptyTelegramConfig();
  notifications: NotificationRecord[] = [];
  audit: AuditLog[] = [];
  schedulers: SchedulerState[] = [];
  heartbeats: Heartbeat[] = [];

  async ping(): Promise<boolean> {
    return true;
  }
  async countUsers(): Promise<number> {
    return this.users.length;
  }
  async createUser(user: UserRecord): Promise<UserRecord> {
    const stored = { ...user, email: user.email.toLowerCase() };
    this.users.push(clone(stored));
    return clone(stored);
  }
  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return clone(this.users.find((user) => user.email === email.toLowerCase()) ?? null);
  }
  async listAgents(): Promise<Agent[]> {
    return clone(this.agents);
  }
  async getAgent(id: string): Promise<Agent | null> {
    return clone(this.agents.find((agent) => agent.id === id) ?? null);
  }
  async insertAgent(agent: Agent): Promise<Agent> {
    this.agents.push(clone(agent));
    return clone(agent);
  }
  async updateAgent(agent: Agent): Promise<Agent> {
    const index = this.agents.findIndex((item) => item.id === agent.id);
    if (index < 0) throw new Error("agent not found");
    this.agents[index] = clone(agent);
    return clone(agent);
  }
  async deleteAgent(id: string): Promise<void> {
    const taskIds = new Set(this.tasks.filter((task) => task.agentId === id).map((task) => task.id));
    const runIds = new Set(this.runs.filter((run) => run.agentId === id).map((run) => run.id));
    this.agents = this.agents.filter((agent) => agent.id !== id);
    this.workflows = this.workflows.filter((workflow) => workflow.agentId !== id);
    this.tasks = this.tasks.filter((task) => task.agentId !== id);
    this.runs = this.runs.filter((run) => run.agentId !== id);
    this.events = this.events.filter((event) => event.agentId !== id);
    this.checkpoints = this.checkpoints.filter((checkpoint) => !runIds.has(checkpoint.taskRunId));
    this.approvals = this.approvals.filter((approval) => approval.agentId !== id);
    this.memories = this.memories.filter((memory) => memory.agentId !== id);
    this.assignments = this.assignments.filter((assignment) => assignment.agentId !== id);
    this.notifications = this.notifications.filter((notification) => notification.agentId !== id);
    this.schedulers = this.schedulers.filter((state) => state.agentId !== id);
    this.tasks = this.tasks.filter((task) => !taskIds.has(task.id));
  }
  async getWorkflow(agentId: string): Promise<Workflow | null> {
    return clone(this.workflows.find((workflow) => workflow.agentId === agentId) ?? null);
  }
  async saveWorkflow(workflow: Workflow): Promise<Workflow> {
    const index = this.workflows.findIndex((item) => item.agentId === workflow.agentId);
    if (index < 0) this.workflows.push(clone(workflow));
    else this.workflows[index] = clone(workflow);
    return clone(workflow);
  }
  async listTasks(agentId?: string): Promise<Task[]> {
    return clone(this.tasks.filter((task) => !agentId || task.agentId === agentId));
  }
  async getTask(id: string): Promise<Task | null> {
    return clone(this.tasks.find((task) => task.id === id) ?? null);
  }
  async saveTask(task: Task): Promise<Task> {
    const index = this.tasks.findIndex((item) => item.id === task.id);
    if (index < 0) this.tasks.push(clone(task));
    else this.tasks[index] = clone(task);
    return clone(task);
  }
  async listRuns(agentId: string): Promise<TaskRun[]> {
    return clone(this.runs.filter((run) => run.agentId === agentId));
  }
  async findRun(id: string): Promise<TaskRun | null> {
    return clone(this.runs.find((run) => run.id === id) ?? null);
  }
  async createRun(run: TaskRun): Promise<TaskRun> {
    this.runs.push(clone(run));
    return clone(run);
  }
  async updateRun(run: TaskRun): Promise<TaskRun> {
    const index = this.runs.findIndex((item) => item.id === run.id);
    if (index < 0) throw new Error("run not found");
    this.runs[index] = clone(run);
    return clone(run);
  }
  async addEvent(event: TaskEvent): Promise<TaskEvent> {
    this.events.push(clone(event));
    return clone(event);
  }
  async listEvents(agentId?: string, limit = 50): Promise<TaskEvent[]> {
    return clone(
      this.events
        .filter((event) => !agentId || event.agentId === agentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }
  async listEventsForTask(taskId: string, limit = 200): Promise<TaskEvent[]> {
    return clone(
      this.events
        .filter((event) => event.taskId === taskId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }
  async saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    this.checkpoints.push(clone(checkpoint));
    return clone(checkpoint);
  }
  async latestCheckpoint(taskRunId: string): Promise<Checkpoint | null> {
    const rows = this.checkpoints.filter((checkpoint) => checkpoint.taskRunId === taskRunId);
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
  }
  async listCheckpointsForRuns(runIds: string[]): Promise<Checkpoint[]> {
    if (runIds.length === 0) return [];
    const wanted = new Set(runIds);
    return clone(
      this.checkpoints
        .filter((checkpoint) => wanted.has(checkpoint.taskRunId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }
  async createApproval(approval: Approval): Promise<Approval> {
    this.approvals.push(clone(approval));
    return clone(approval);
  }
  async latestApproval(taskId: string): Promise<Approval | null> {
    const rows = this.approvals.filter((approval) => approval.taskId === taskId);
    return clone(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
  }
  async listMemories(agentId: string): Promise<Memory[]> {
    return clone(this.memories.filter((memory) => memory.agentId === agentId));
  }
  async createMemory(memory: Memory): Promise<Memory> {
    this.memories.push(clone(memory));
    return clone(memory);
  }
  async reviseMemory(memory: Memory): Promise<Memory> {
    const index = this.memories.findIndex((item) => item.id === memory.id);
    if (index < 0) throw new Error("memory not found");
    this.memories[index] = clone(memory);
    return clone(memory);
  }
  async deleteMemory(id: string): Promise<void> {
    this.memories = this.memories.filter((memory) => memory.id !== id);
  }
  async listProviders(): Promise<ProviderRecord[]> {
    return clone(this.providers);
  }
  async getProvider(id: string): Promise<ProviderRecord | null> {
    return clone(this.providers.find((provider) => provider.id === id) ?? null);
  }
  async insertProvider(provider: ProviderRecord): Promise<ProviderRecord> {
    this.providers.push(clone(provider));
    return clone(provider);
  }
  async updateProvider(provider: ProviderRecord): Promise<ProviderRecord> {
    const index = this.providers.findIndex((item) => item.id === provider.id);
    if (index < 0) throw new Error("provider not found");
    this.providers[index] = clone(provider);
    return clone(provider);
  }
  async deleteProvider(id: string): Promise<void> {
    const modelIds = new Set(this.models.filter((model) => model.providerId === id).map((model) => model.id));
    this.assignments = this.assignments.flatMap((assignment) => {
      if (modelIds.has(assignment.modelId)) return [];
      if (assignment.fallbackModelId && modelIds.has(assignment.fallbackModelId)) return [{ ...assignment, fallbackModelId: null }];
      return [assignment];
    });
    this.providers = this.providers.filter((provider) => provider.id !== id);
    this.models = this.models.filter((model) => model.providerId !== id);
  }
  async listModels(): Promise<ModelRecord[]> {
    return clone(this.models);
  }
  async getModel(id: string): Promise<ModelRecord | null> {
    return clone(this.models.find((model) => model.id === id) ?? null);
  }
  async insertModel(model: ModelRecord): Promise<ModelRecord> {
    this.models.push(clone(model));
    return clone(model);
  }
  async updateModel(model: ModelRecord): Promise<ModelRecord> {
    const index = this.models.findIndex((item) => item.id === model.id);
    if (index < 0) throw new Error("model not found");
    this.models[index] = clone(model);
    return clone(model);
  }
  async listAssignments(): Promise<ModelAssignment[]> {
    return clone(this.assignments);
  }
  async saveAssignment(assignment: ModelAssignment): Promise<ModelAssignment> {
    const index = this.assignments.findIndex((item) => item.activity === assignment.activity && item.agentId === assignment.agentId);
    if (index < 0) this.assignments.push(clone(assignment));
    else this.assignments[index] = clone(assignment);
    return clone(assignment);
  }
  async addUsage(entry: UsageEntry): Promise<void> {
    this.usage.push(clone(entry));
  }
  async usageSince(isoDate: string): Promise<UsageEntry[]> {
    return clone(this.usage.filter((entry) => entry.createdAt >= isoDate));
  }
  async putSecret(secret: StoredSecret): Promise<StoredSecret> {
    const index = this.secrets.findIndex((item) => item.id === secret.id);
    if (index < 0) this.secrets.push(clone(secret));
    else this.secrets[index] = clone(secret);
    return clone(secret);
  }
  async getSecret(id: string): Promise<StoredSecret | null> {
    return clone(this.secrets.find((secret) => secret.id === id) ?? null);
  }
  async getTelegramConfig(): Promise<TelegramConfig | null> {
    return clone(this.telegram);
  }
  async saveTelegramConfig(config: TelegramConfig): Promise<TelegramConfig> {
    this.telegram = clone(config);
    return clone(config);
  }
  async addNotification(notification: NotificationRecord): Promise<NotificationRecord> {
    this.notifications.push(clone(notification));
    return clone(notification);
  }
  async listNotifications(limit = 50): Promise<NotificationRecord[]> {
    return clone([...this.notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }
  async listUndelivered(): Promise<NotificationRecord[]> {
    return clone(this.notifications.filter((notification) => !notification.delivered));
  }
  async markDelivered(ids: string[]): Promise<void> {
    for (const notification of this.notifications) {
      if (ids.includes(notification.id)) notification.delivered = true;
    }
  }
  async addAudit(entry: AuditLog): Promise<void> {
    this.audit.push(clone(entry));
  }
  async listAudit(limit = 50): Promise<AuditLog[]> {
    return clone([...this.audit].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }
  async getScheduler(agentId: string): Promise<SchedulerState | null> {
    return clone(this.schedulers.find((state) => state.agentId === agentId) ?? null);
  }
  async saveScheduler(state: SchedulerState): Promise<SchedulerState> {
    const index = this.schedulers.findIndex((item) => item.agentId === state.agentId);
    if (index < 0) this.schedulers.push(clone(state));
    else this.schedulers[index] = clone(state);
    return clone(state);
  }
  async saveHeartbeat(heartbeat: Heartbeat): Promise<void> {
    const index = this.heartbeats.findIndex((item) => item.id === heartbeat.id);
    if (index < 0) this.heartbeats.push(clone(heartbeat));
    else this.heartbeats[index] = clone(heartbeat);
  }
  async getHeartbeat(id: string): Promise<Heartbeat | null> {
    return clone(this.heartbeats.find((heartbeat) => heartbeat.id === id) ?? null);
  }
}
