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

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface PlatformStore {
  ping(): Promise<boolean>;
  countUsers(): Promise<number>;
  createUser(user: UserRecord): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
  insertAgent(agent: Agent): Promise<Agent>;
  updateAgent(agent: Agent): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;
  getWorkflow(agentId: string): Promise<Workflow | null>;
  saveWorkflow(workflow: Workflow): Promise<Workflow>;
  listTasks(agentId?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  saveTask(task: Task): Promise<Task>;
  listRuns(agentId: string): Promise<TaskRun[]>;
  findRun(id: string): Promise<TaskRun | null>;
  createRun(run: TaskRun): Promise<TaskRun>;
  updateRun(run: TaskRun): Promise<TaskRun>;
  addEvent(event: TaskEvent): Promise<TaskEvent>;
  listEvents(agentId?: string, limit?: number): Promise<TaskEvent[]>;
  listEventsForTask(taskId: string, limit?: number): Promise<TaskEvent[]>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint>;
  latestCheckpoint(taskRunId: string): Promise<Checkpoint | null>;
  listCheckpointsForRuns(runIds: string[]): Promise<Checkpoint[]>;
  createApproval(approval: Approval): Promise<Approval>;
  latestApproval(taskId: string): Promise<Approval | null>;
  listMemories(agentId: string): Promise<Memory[]>;
  createMemory(memory: Memory): Promise<Memory>;
  reviseMemory(memory: Memory): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  listProviders(): Promise<ProviderRecord[]>;
  getProvider(id: string): Promise<ProviderRecord | null>;
  insertProvider(provider: ProviderRecord): Promise<ProviderRecord>;
  updateProvider(provider: ProviderRecord): Promise<ProviderRecord>;
  deleteProvider(id: string): Promise<void>;
  listModels(): Promise<ModelRecord[]>;
  getModel(id: string): Promise<ModelRecord | null>;
  insertModel(model: ModelRecord): Promise<ModelRecord>;
  updateModel(model: ModelRecord): Promise<ModelRecord>;
  listAssignments(): Promise<ModelAssignment[]>;
  saveAssignment(assignment: ModelAssignment): Promise<ModelAssignment>;
  addUsage(entry: UsageEntry): Promise<void>;
  usageSince(isoDate: string): Promise<UsageEntry[]>;
  putSecret(secret: StoredSecret): Promise<StoredSecret>;
  getSecret(id: string): Promise<StoredSecret | null>;
  getTelegramConfig(): Promise<TelegramConfig | null>;
  saveTelegramConfig(config: TelegramConfig): Promise<TelegramConfig>;
  addNotification(notification: NotificationRecord): Promise<NotificationRecord>;
  listNotifications(limit?: number): Promise<NotificationRecord[]>;
  listUndelivered(): Promise<NotificationRecord[]>;
  markDelivered(ids: string[]): Promise<void>;
  addAudit(entry: AuditLog): Promise<void>;
  listAudit(limit?: number): Promise<AuditLog[]>;
  getScheduler(agentId: string): Promise<SchedulerState | null>;
  saveScheduler(state: SchedulerState): Promise<SchedulerState>;
  saveHeartbeat(heartbeat: Heartbeat): Promise<void>;
  getHeartbeat(id: string): Promise<Heartbeat | null>;
}
