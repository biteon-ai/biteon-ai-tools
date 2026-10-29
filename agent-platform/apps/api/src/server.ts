import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { ZodError, z } from "zod";
import {
  ACTIVITIES,
  COST_CLASSES,
  DEFAULT_COLUMNS,
  DEFAULT_SELECTION_RULES,
  EXECUTORS,
  MEMORY_KINDS,
  PROVIDER_TYPES,
  SKILLS,
  TASK_PROVIDERS,
  defaultAgentName,
  defaultRules,
  emptyScheduler,
  newId,
  nowIso,
  type Agent,
  type ProviderRecord,
  type StoredSecret,
  type Task,
} from "@agent-platform/shared";
import {
  ConfigError,
  WorkflowError,
  approveTask,
  assertAssignment,
  assertCostClass,
  parseRepositoryRef,
  describeTickets,
  findDuplicateModel,
  findProviderMatch,
  mergeCards,
  describeColumn,
  describeProblems,
  describePaidTokens,
  describeProgress,
  isTokenLimitError,
  paidTokenReport,
  startOfUtcDay,
  describeProject,
  describeTicket,
  findTickets,
  interpretProjectChat,
  PROJECT_HELP,
  PROJECT_SCOPE,
  resolveTicket,
  shiftToTicket,
  clearSessionCookie,
  columnForStage,
  decryptSecret,
  encryptSecret,
  formatNotification,
  masterKeyIsExample,
  readCookie,
  rejectTask,
  secretHint,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
  type PlatformEnv,
} from "@agent-platform/core";
import type { PlatformStore } from "@agent-platform/db";
import { createBoardClient, listBoardColumns, listGithubProjects, listTrelloBoards, listTrelloLists, mergeApprovedChanges, PAIRING_TTL_SECONDS, parseCredentials, readTrelloCardMove, refreshStoredBoard, listProviderModels, registerTrelloWebhook, sendTelegramMessage, telegramBotProfile, telegramDeepLink, type PairingStore } from "@agent-platform/integrations";
import type { TickQueue } from "./queue.js";

export interface ServerDeps {
  store: PlatformStore;
  env: PlatformEnv;
  queue: TickQueue;
  pairing: PairingStore;
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

const CreateAgent = z.object({
  name: z.string().min(1).optional(),
  description: z.string().default(""),
  repositoryUrl: z.string().default(""),
  repositoryName: z.string().default(""),
  linkedRepositories: z.array(z.string()).max(8).default([]),
  defaultBranch: z.string().min(1).default("develop"),
  provider: z.enum(TASK_PROVIDERS).default("none"),
  boardId: z.string().default(""),
  boardName: z.string().default(""),
  executorKind: z.enum(EXECUTORS).default("fake"),
  dailyCapacityHours: z.number().positive().max(24).default(8),
  allowOverCapacity: z.boolean().default(false),
  credential: z.string().optional(),
  boardKey: z.string().optional(),
  boardToken: z.string().optional(),
  telegramChatId: z.string().default(""),
});

const ProviderBody = z.object({
  name: z.string().min(1),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().default(""),
  costClass: z.enum(COST_CLASSES),
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
});

const ModelBody = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  costClass: z.enum(COST_CLASSES),
  enabled: z.boolean().default(true),
  parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

const AssignmentBody = z.object({
  agentId: z.string().uuid().nullable().default(null),
  activity: z.enum(ACTIVITIES),
  modelId: z.string().uuid(),
  fallbackModelId: z.string().uuid().nullable().default(null),
  maxTokens: z.number().int().positive().default(4000),
  dailyTokenBudget: z.number().int().positive().nullable().default(null),
  allowLocalOnly: z.boolean().default(false),
  requirePaid: z.boolean().default(false),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : "";
    if (!text.trim()) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  const secure = deps.env.COOKIE_SECURE === "true";

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "invalid request" });
    if (error instanceof WorkflowError) return reply.code(409).send({ error: error.message });
    if (error instanceof ConfigError) return reply.code(400).send({ error: error.message });
    request.log.error({ message: error instanceof Error ? error.message : "error" }, "request failed");
    return reply.code(500).send({ error: "internal error" });
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? "";
    if (pathname === "/health" || pathname === "/ready" || pathname === "/api/auth/login" || pathname === "/api/webhooks/trello") return;
    const token = readCookie(request.headers.cookie, "session");
    if (!token) return reply.code(401).send({ error: "authentication required" });
    try {
      const session = await verifySession(token, deps.env.SESSION_SECRET);
      request.userId = session.userId;
      request.userEmail = session.email;
    } catch {
      return reply.code(401).send({ error: "authentication required" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const database = await deps.store.ping().catch(() => false);
    const queue = await deps.queue.ping().catch(() => false);
    const body = { status: database ? "ok" : "degraded", database, queue };
    return reply.code(database ? 200 : 503).send(body);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const user = await deps.store.findUserByEmail(body.email.toLowerCase());
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const token = await signSession(user.id, user.email, deps.env.SESSION_SECRET);
    reply.header("set-cookie", sessionCookie(token, secure));
    return { email: user.email };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", clearSessionCookie(secure));
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ email: request.userEmail ?? "" }));

  app.get("/api/dashboard", async () => dashboard(deps));
  app.get("/api/skills", async () => SKILLS);

  app.get("/api/agents", async () => deps.store.listAgents());
  app.post("/api/agents", async (request, reply) => {
    const body = CreateAgent.parse(request.body);
    const agent = await createAgent(deps, body, request.userId ?? "admin");
    await ensureTrelloWebhook(deps, agent);
    return reply.code(201).send(agent);
  });
  app.get("/api/agents/:id", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const [workflow, tasks, events, memories, runs] = await Promise.all([
      deps.store.getWorkflow(agent.id),
      deps.store.listTasks(agent.id),
      deps.store.listEvents(agent.id, 50),
      deps.store.listMemories(agent.id),
      deps.store.listRuns(agent.id),
    ]);
    const secret = agent.credentialSecretId ? await deps.store.getSecret(agent.credentialSecretId) : null;
    return {
      agent: { ...agent, credential: { configured: Boolean(secret), hint: secret?.hint ?? "" } },
      workflow,
      tasks,
      events,
      memories,
      runs,
    };
  });
  app.patch("/api/agents/:id", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      repositoryUrl: z.string().optional(),
      repositoryName: z.string().optional(),
      linkedRepositories: z.array(z.string()).max(8).optional(),
      defaultBranch: z.string().min(1).optional(),
      provider: z.enum(TASK_PROVIDERS).optional(),
      boardId: z.string().optional(),
      boardName: z.string().optional(),
      executorKind: z.enum(EXECUTORS).optional(),
      dailyCapacityHours: z.number().positive().max(24).optional(),
      allowOverCapacity: z.boolean().optional(),
      credential: z.string().optional(),
      boardKey: z.string().optional(),
      boardToken: z.string().optional(),
      telegramChatId: z.string().optional(),
    }).parse(request.body ?? {});
    const { credential, boardKey, boardToken, ...rest } = body;
    const next = { ...agent, ...rest, updatedAt: nowIso() };
    if (body.linkedRepositories || body.repositoryName || body.repositoryUrl) {
      next.linkedRepositories = normalizeLinked(body.repositoryName ?? agent.repositoryName, body.repositoryUrl ?? agent.repositoryUrl, body.linkedRepositories ?? agent.linkedRepositories);
    }
    const provider = body.provider ?? agent.provider;
    const replacement = boardCredential(provider, credential, boardKey, boardToken, await currentBoardCredential(deps, agent));
    const stored = await storedBoardCredential(deps, `${next.name} credential`, replacement);
    if (stored) next.credentialSecretId = stored;
    await deps.store.updateAgent(next);
    await ensureTrelloWebhook(deps, next);
    await audit(deps, request.userId, "agent.update", next.id);
    return next;
  });
  app.delete("/api/agents/:id", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    await writeFile(path.join(agent.workspacePath, "REMOVED"), `removed ${nowIso()}\n`, "utf8").catch(() => undefined);
    await deps.store.deleteAgent(agent.id);
    await audit(deps, request.userId, "agent.remove", agent.id);
    return { removed: true, workspaceRetained: true };
  });

  for (const action of ["start", "stop", "pause", "resume", "restart"] as const) {
    app.post(`/api/agents/:id/${action}`, async (request, reply) => {
      const agent = await requireAgent(deps, request, reply);
      if (!agent) return;
      const status = action === "stop" ? "stopped" : action === "pause" ? "paused" : "running";
      const next = { ...agent, status, updatedAt: nowIso() } as Agent;
      await deps.store.updateAgent(next);
      if (action === "start" || action === "resume" || action === "restart") await deps.queue.enqueue(agent.id);
      await audit(deps, request.userId, `agent.${action}`, agent.id);
      return next;
    });
  }

  app.post("/api/agents/:id/tick", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    await deps.queue.enqueue(agent.id);
    return { queued: true };
  });

  app.get("/api/agents/:id/tasks", async (request) => deps.store.listTasks(idParam(request)));
  app.post("/api/agents/:id/tasks", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({
      title: z.string().min(1),
      description: z.string().default(""),
      acceptanceCriteria: z.string().default(""),
      priority: z.number().int().default(3),
      estimateHours: z.number().positive().nullable().default(null),
      dependsOn: z.array(z.string()).default([]),
    }).parse(request.body);
    const timestamp = nowIso();
    const task: Task = {
      id: newId(),
      agentId: agent.id,
      externalId: `local-${newId()}`,
      title: body.title,
      description: body.description,
      acceptanceCriteria: body.acceptanceCriteria,
      comments: [],
      url: "",
      stage: "backlog",
      priority: body.priority,
      estimateHours: body.estimateHours,
      dependsOn: body.dependsOn,
      dueAt: null,
      plan: "",
      branchName: "",
      prUrl: "",
      blockedReason: "",
      exceptionNote: "",
      checksPassed: false,
      labels: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await deps.store.saveTask(task);
    return reply.code(201).send(task);
  });
  app.get("/api/agents/:id/events", async (request) => deps.store.listEvents(idParam(request), 100));
  app.get("/api/agents/:id/memories", async (request) => deps.store.listMemories(idParam(request)));
  app.post("/api/agents/:id/memories", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({
      kind: z.enum(MEMORY_KINDS),
      title: z.string().min(1),
      body: z.string().min(1),
      sourceRefs: z.array(z.string()).default([]),
    }).parse(request.body);
    const timestamp = nowIso();
    const memory = await deps.store.createMemory({
      id: newId(),
      agentId: agent.id,
      kind: body.kind,
      title: body.title,
      body: body.body,
      sourceRefs: body.sourceRefs,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return reply.code(201).send(memory);
  });
  app.delete("/api/agents/:id/memories/:memoryId", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const memoryId = (request.params as { memoryId: string }).memoryId;
    const memory = (await deps.store.listMemories(agent.id)).find((item) => item.id === memoryId);
    if (!memory) return reply.code(404).send({ error: "memory not found" });
    await deps.store.deleteMemory(memory.id);
    return { ok: true };
  });
  app.get("/api/agents/:id/runs", async (request) => deps.store.listRuns(idParam(request)));
  app.get("/api/agents/:id/workflow", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    return deps.store.getWorkflow(agent.id);
  });
  app.put("/api/agents/:id/workflow", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({
      columns: z.object({
        backlog: z.string().min(1),
        planning: z.string(),
        todo: z.string().min(1),
        doing: z.string().min(1),
        review: z.string().min(1),
        done: z.string().min(1),
      }),
      selection: z.object({
        priorityLabels: z.array(z.string()),
        blockedLabels: z.array(z.string()),
        maxTasksPerDay: z.union([z.number().int().min(0).max(1000), z.null()]).transform((value) => value ?? 0),
      }),
    }).parse(request.body);
    const existing = await deps.store.getWorkflow(agent.id);
    const timestamp = nowIso();
    return deps.store.saveWorkflow({
      id: existing?.id ?? newId(),
      agentId: agent.id,
      name: existing?.name ?? "Default",
      columns: body.columns,
      selection: body.selection,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  });
  app.put("/api/agents/:id/rules", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const rules = z.object({
      codingStandards: z.string(),
      architecturePrinciples: z.string(),
      testingRequirements: z.string(),
      validationCommands: z.array(z.array(z.string().min(1)).min(1)),
      allowEmptyChecks: z.boolean(),
      branchPattern: z.string().min(1),
      maxRetries: z.number().int().min(0).max(10),
      stallMinutes: z.number().int().min(1).max(1440),
      instructions: z.string(),
      skills: z.record(z.boolean()),
      customSkills: z.array(z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80),
        description: z.string().max(240).default(""),
      })).max(40).optional(),
    }).parse(request.body);
    const next = {
      ...agent,
      rules: { ...rules, customSkills: rules.customSkills ?? agent.rules.customSkills ?? [] },
      updatedAt: nowIso(),
    };
    await deps.store.updateAgent(next);
    return next.rules;
  });
  app.post("/api/agents/:id/skills", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(240).default(""),
    }).parse(request.body);
    const customSkills = agent.rules.customSkills ?? [];
    const known = new Set([
      ...SKILLS.map((skill) => skill.name.trim().toLowerCase()),
      ...customSkills.map((skill) => skill.name.trim().toLowerCase()),
    ]);
    if (known.has(body.name.toLowerCase())) return reply.code(409).send({ error: "This agent already has that skill" });
    const id = customSkillId(body.name, [...SKILLS.map((skill) => skill.id), ...customSkills.map((skill) => skill.id)]);
    const skill = { id, name: body.name, description: body.description };
    const rules = {
      ...agent.rules,
      customSkills: [...customSkills, skill],
      skills: { ...agent.rules.skills, [id]: true },
    };
    await deps.store.updateAgent({ ...agent, rules, updatedAt: nowIso() });
    return reply.code(201).send({ skill, rules });
  });
  app.delete("/api/agents/:id/skills/:skillId", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const skillId = (request.params as { skillId: string }).skillId;
    const customSkills = agent.rules.customSkills ?? [];
    const skill = customSkills.find((item) => item.id === skillId);
    if (!skill || SKILLS.some((item) => item.id === skillId)) return reply.code(404).send({ error: "custom skill not found" });
    const skills = { ...agent.rules.skills };
    delete skills[skillId];
    const rules = { ...agent.rules, customSkills: customSkills.filter((item) => item.id !== skillId), skills };
    await deps.store.updateAgent({ ...agent, rules, updatedAt: nowIso() });
    return { rules };
  });
  app.get("/api/agents/:id/board-columns", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    let credentials = { key: "", token: "" };
    try {
      credentials = await credentialsFor(deps, agent);
    } catch {
      return { columns: [], connected: false };
    }
    const connected = agent.provider !== "none" && Boolean(agent.boardId) && Boolean(credentials.token) && (agent.provider !== "trello" || Boolean(credentials.key));
    if (!connected) {
      const reason = agent.provider === "trello" && agent.boardId && credentials.token && !credentials.key ? "trello_key_missing" : undefined;
      return reason ? { columns: [], connected: false, reason } : { columns: [], connected: false };
    }
    try {
      const columns = await listBoardColumns({ provider: agent.provider, boardId: agent.boardId, credentials, fetchImpl: deps.fetchImpl });
      return { columns, connected: true };
    } catch {
      return reply.code(502).send({ error: "Could not load board columns" });
    }
  });
  app.post("/api/agents/:id/chat", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const body = z.object({ message: z.string().trim().min(1).max(500) }).parse(request.body);
    const intent = interpretProjectChat(body.message);
    const readsBoard = intent.kind === "status" || intent.kind === "list" || intent.kind === "backlog" || intent.kind === "done" || intent.kind === "problems" || intent.kind === "about" || intent.kind === "ticket" || intent.kind === "progress";
    const refreshed = readsBoard ? await refreshBoardTasks(deps, agent) : { tasks: await deps.store.listTasks(agent.id), boardError: null };
    const tasks = refreshed.tasks;
    let replyText = PROJECT_SCOPE;
    let changed: Task[] = [];
    if (intent.kind === "help") replyText = PROJECT_HELP;
    if (intent.kind === "status" || intent.kind === "about") {
      replyText = describeProject(agent, tasks, new Date());
      if (refreshed.boardError) replyText = `${replyText}\n${refreshed.boardError}`;
    }
    if (intent.kind === "list") replyText = refreshed.boardError && tasks.length === 0 ? refreshed.boardError : describeTickets(tasks);
    if (intent.kind === "backlog") replyText = refreshed.boardError && tasks.length === 0 ? refreshed.boardError : describeColumn(tasks, "backlog");
    if (intent.kind === "done") replyText = describeColumn(tasks, "done", 12);
    if (intent.kind === "progress") replyText = describeProgress(tasks, await deps.store.listRuns(agent.id), intent.query, new Date());
    if (intent.kind === "tokens") {
      const now = new Date();
      const [assignments, models, providers, usage, runs] = await Promise.all([
        deps.store.listAssignments(),
        deps.store.listModels(),
        deps.store.listProviders(),
        deps.store.usageSince(startOfUtcDay(now).toISOString()),
        deps.store.listRuns(agent.id),
      ]);
      replyText = describePaidTokens(agent.name, paidTokenReport({
        agentId: agent.id,
        assignments,
        models,
        providers,
        usage,
        limitRuns: runs.filter((run) => run.costClass === "paid" && isTokenLimitError(run.error)).map((run) => ({ modelId: run.modelId, error: run.error })),
      }));
    }
    if (intent.kind === "problems") {
      replyText = describeProblems(agent, tasks);
      if (refreshed.boardError) replyText = `${replyText}\n${refreshed.boardError}`;
    }
    if (intent.kind === "restart" || intent.kind === "start" || intent.kind === "push") {
      agent.status = "running";
      agent.updatedAt = nowIso();
      await deps.store.updateAgent(agent);
      await deps.queue.enqueue(agent.id);
      const project = agent.repositoryName || agent.boardName || "its project";
      replyText = intent.kind === "push"
        ? `${agent.name} is pushed to work on ${project}.`
        : intent.kind === "start"
          ? `${agent.name} started on ${project} and is pushed to work.`
          : `${agent.name} restarted on ${project} and is pushed to work.`;
    }
    if (intent.kind === "ticket" || intent.kind === "out_of_scope") {
      const matches = findTickets(tasks, intent.kind === "ticket" ? intent.query : body.message);
      if (matches.length === 1) replyText = `${describeTicket(matches[0]!)}\nSay “work on ${matches[0]!.title}” to switch to it.`;
      else if (matches.length > 1) replyText = `Several tickets match: ${matches.map((task) => `#${task.externalId} ${task.title}`).join(", ")}. Name one of them.`;
      else if (intent.kind === "ticket") replyText = `Ticket ${intent.query} was not found.`;
    }
    if (intent.kind === "pause" || intent.kind === "resume") {
      agent.status = intent.kind === "resume" ? "running" : "paused";
      agent.updatedAt = nowIso();
      await deps.store.updateAgent(agent);
      if (agent.status === "running") await deps.queue.enqueue(agent.id);
      replyText = `${agent.name} is ${agent.status}.`;
    }
    if (intent.kind === "stop") {
      agent.status = "stopped";
      agent.updatedAt = nowIso();
      await deps.store.updateAgent(agent);
      replyText = `${agent.name} is stopped.`;
    }
    if (intent.kind === "tick") {
      await deps.queue.enqueue(agent.id);
      const project = agent.repositoryName || agent.boardName || "its project";
      replyText = `${agent.name} is queued for a tick on ${project}.`;
    }
    if (intent.kind === "sync") {
      const synced = await refreshBoardTasks(deps, agent);
      replyText = synced.boardError ?? (agent.provider === "none" || !agent.boardId
        ? `${agent.name} has no board to sync. ${synced.tasks.length} ticket${synced.tasks.length === 1 ? " is" : "s are"} already stored.`
        : `${agent.name} synced ${synced.tasks.length} ticket${synced.tasks.length === 1 ? "" : "s"} from the board.`);
    }
    if (intent.kind === "approve" || intent.kind === "reject") {
      const reviews = tasks.filter((task) => task.stage === "review");
      const matches = intent.ticket ? findTickets(tasks, intent.ticket) : reviews;
      const target = matches.length === 1 ? matches[0] : undefined;
      if (!target) replyText = matches.length > 1
        ? `Name the ticket to ${intent.kind}: ${matches.map((task) => `#${task.externalId} ${task.title}`).join(", ")}.`
        : intent.ticket ? `Ticket ${intent.ticket} was not found.` : "Nothing is in Review.";
      else {
        try {
          const next = intent.kind === "approve" ? approveTask(target, { source: "ui" }) : rejectTask(target, "rejected from the project chat");
          await deps.store.createApproval({
            id: newId(),
            taskId: target.id,
            agentId: agent.id,
            source: "ui",
            decision: intent.kind === "approve" ? "approved" : "rejected",
            actor: "ui",
            comment: body.message,
            createdAt: nowIso(),
          });
          await deps.store.saveTask(next);
          changed = [next];
          replyText = `${target.title} is ${next.stage}.`;
          const workflow = await deps.store.getWorkflow(agent.id);
          const credentials = await credentialsFor(deps, agent);
          const board = workflow ? createBoardClient({ provider: agent.provider, boardId: agent.boardId, credentials, fetchImpl: deps.fetchImpl }) : null;
          const column = workflow ? columnForStage(workflow.columns, next.stage) : null;
          if (board && column) {
            const moved = await board.moveCard(next.externalId, column).then(() => true).catch(() => false);
            if (!moved) replyText += " The board column was not updated.";
          }
        } catch (error) {
          replyText = error instanceof WorkflowError ? error.message : "That ticket is not in Review.";
        }
      }
    }
    if (intent.kind === "shift") {
      const matches = findTickets(tasks, intent.ticket);
      const target = matches.length === 1 ? matches[0] : resolveTicket(tasks, intent.ticket);
      if (matches.length > 1) replyText = `Several tickets match “${intent.ticket}”: ${matches.map((task) => `#${task.externalId} ${task.title}`).join(", ")}. Name one of them.`;
      else if (!target) replyText = `Ticket ${intent.ticket} was not found.`;
      else {
        const shifted = shiftToTicket(tasks, target, nowIso());
        changed = shifted.changed;
        replyText = shifted.reply;
        for (const task of changed) await deps.store.saveTask(task);
        if (changed.length > 0 && agent.status === "running") await deps.queue.enqueue(agent.id);
        const workflow = await deps.store.getWorkflow(agent.id);
        const credentials = await credentialsFor(deps, agent);
        const board = workflow ? createBoardClient({ provider: agent.provider, boardId: agent.boardId, credentials, fetchImpl: deps.fetchImpl }) : null;
        if (board && workflow) {
          for (const task of changed) {
            const column = columnForStage(workflow.columns, task.stage);
            if (!column) continue;
            const moved = await board.moveCard(task.externalId, column).then(() => true).catch(() => false);
            if (!moved) replyText += " The board column was not updated.";
          }
        }
      }
    }
    const recent = await deps.store.listEvents(agent.id, 1);
    if (recent[0]?.kind !== "chat" || recent[0].message !== replyText) {
      await deps.store.addEvent({
        id: newId(),
        agentId: agent.id,
        taskId: changed[0]?.id ?? null,
        kind: "chat",
        message: replyText,
        metadata: { command: body.message },
        createdAt: nowIso(),
      });
    }
    return { reply: replyText, tasks: await deps.store.listTasks(agent.id), boardError: refreshed.boardError };
  });
  app.post("/api/agents/:id/sync", async (request, reply) => {
    const agent = await requireAgent(deps, request, reply);
    if (!agent) return;
    const refreshed = await refreshBoardTasks(deps, agent);
    if (refreshed.boardError) return reply.code(409).send({ error: refreshed.boardError });
    return { tasks: refreshed.tasks.length, notices: refreshed.notices };
  });
  app.head("/api/webhooks/trello", async (_request, reply) => reply.code(200).send());
  app.get("/api/webhooks/trello", async () => ({ ok: true }));
  app.post("/api/webhooks/trello", async (request) => {
    await applyTrelloMove(deps, request.body);
    return { ok: true };
  });
  app.post("/api/boards/:id/sync", async (request, reply) => {
    const id = idParam(request);
    const agents = await deps.store.listAgents();
    const agent = agents.find((item) => item.id === id || item.boardId === id);
    if (!agent) return reply.code(404).send({ error: "board not found" });
    const refreshed = await refreshBoardTasks(deps, agent);
    if (refreshed.boardError && refreshed.notices.length === 0) return reply.code(409).send({ error: refreshed.boardError });
    return { tasks: refreshed.tasks, notices: refreshed.notices, boardError: refreshed.boardError };
  });

  app.post("/api/tasks/:id/approve", async (request, reply) => decide(deps, request, reply, "approved"));
  app.post("/api/tasks/:id/reject", async (request, reply) => decide(deps, request, reply, "rejected"));

  app.get("/api/providers", async () => {
    const providers = await deps.store.listProviders();
    return Promise.all(providers.map((provider) => publicProvider(deps, provider)));
  });
  app.post("/api/providers", async (request, reply) => {
    const body = ProviderBody.parse(request.body);
    assertCostClass(body.type, body.costClass);
    const raw = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const existing = findProviderMatch(await deps.store.listProviders(), body);
    if (existing) {
      const next: ProviderRecord = {
        ...existing,
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl,
        costClass: body.costClass,
        enabled: "enabled" in raw ? body.enabled : existing.enabled,
        updatedAt: nowIso(),
      };
      if (body.apiKey) next.secretId = await storeCredential(deps, `${next.name} api key`, body.apiKey);
      await deps.store.updateProvider(next);
      return reply.code(200).send({ ...(await publicProvider(deps, next)), updated: true });
    }
    const timestamp = nowIso();
    const provider: ProviderRecord = {
      id: newId(),
      name: body.name,
      type: body.type,
      baseUrl: body.baseUrl,
      costClass: body.costClass,
      enabled: body.enabled,
      secretId: body.apiKey ? await storeCredential(deps, `${body.name} api key`, body.apiKey) : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await deps.store.insertProvider(provider);
    return reply.code(201).send({ ...(await publicProvider(deps, provider)), updated: false });
  });
  app.patch("/api/providers/:id", async (request, reply) => {
    const id = idParam(request);
    const existing = await deps.store.getProvider(id);
    if (!existing) return reply.code(404).send({ error: "provider not found" });
    const body = z.object({
      name: z.string().min(1).optional(),
      type: z.enum(PROVIDER_TYPES).optional(),
      baseUrl: z.string().optional(),
      costClass: z.enum(COST_CLASSES).optional(),
      apiKey: z.string().optional(),
      enabled: z.boolean().optional(),
    }).parse(request.body ?? {});
    const { apiKey, ...rest } = body;
    const next: ProviderRecord = { ...existing, ...rest, updatedAt: nowIso() };
    assertCostClass(next.type, next.costClass);
    if (findProviderMatch(await deps.store.listProviders(), next)) {
      return reply.code(409).send({ error: "This provider already exists" });
    }
    if (apiKey) next.secretId = await storeCredential(deps, `${next.name} api key`, apiKey);
    await deps.store.updateProvider(next);
    return publicProvider(deps, next);
  });
  app.delete("/api/providers/:id", async (request, reply) => {
    const existing = await deps.store.getProvider(idParam(request));
    if (!existing) return reply.code(404).send({ error: "provider not found" });
    await deps.store.deleteProvider(existing.id);
    return { removed: true };
  });
  app.post("/api/providers/:id/probe", async (request, reply) => {
    const provider = await deps.store.getProvider(idParam(request));
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    return probeProvider(deps, provider);
  });
  app.get("/api/providers/:id/models", async (request, reply) => {
    const provider = await deps.store.getProvider(idParam(request));
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    const secret = provider.secretId ? await deps.store.getSecret(provider.secretId) : null;
    let apiKey = "";
    try {
      apiKey = secret ? decryptSecret(secret, deps.env.APP_MASTER_KEY) : "";
    } catch {
      apiKey = "";
    }
    if (!apiKey) apiKey = providerKeyFromEnv(deps.env, provider.type);
    const fallback = providerKeyFromEnv(deps.env, provider.type);
    try {
      return { models: await listProviderModels({ type: provider.type, baseUrl: provider.baseUrl, apiKey, fetchImpl: deps.fetchImpl }) };
    } catch (error) {
      if (fallback && fallback !== apiKey) {
        try {
          return { models: await listProviderModels({ type: provider.type, baseUrl: provider.baseUrl, apiKey: fallback, fetchImpl: deps.fetchImpl }) };
        } catch {
          // The saved provider key and the environment key both failed.
        }
      }
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Could not load models" });
    }
  });

  app.get("/api/models", async () => deps.store.listModels());
  app.post("/api/models", async (request, reply) => {
    const body = ModelBody.parse(request.body);
    const provider = await deps.store.getProvider(body.providerId);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    assertCostClass(provider.type, body.costClass);
    if (findDuplicateModel(await deps.store.listModels(), body)) {
      return reply.code(409).send({ error: "This provider already has that model" });
    }
    const model = { id: newId(), ...body, createdAt: nowIso() };
    await deps.store.insertModel(model);
    return reply.code(201).send(model);
  });
  app.patch("/api/models/:id", async (request, reply) => {
    const existing = await deps.store.getModel(idParam(request));
    if (!existing) return reply.code(404).send({ error: "model not found" });
    const body = ModelBody.partial().parse(request.body);
    const next = { ...existing, ...body };
    const provider = await deps.store.getProvider(next.providerId);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    assertCostClass(provider.type, next.costClass);
    if (findDuplicateModel(await deps.store.listModels(), next)) {
      return reply.code(409).send({ error: "This provider already has that model" });
    }
    await deps.store.updateModel(next);
    return next;
  });

  app.get("/api/assignments", async () => deps.store.listAssignments());
  app.put("/api/assignments", async (request) => {
    const body = AssignmentBody.parse(request.body);
    assertAssignment(body);
    const saved = await deps.store.saveAssignment({ id: newId(), ...body });
    return saved;
  });

  app.get("/api/telegram", async () => publicTelegram(deps));
  app.put("/api/telegram", async (request) => {
    const body = z.object({
      enabled: z.boolean(),
      chatId: z.string().default(""),
      minSeverity: z.enum(["info", "warning", "urgent"]).default("warning"),
      digestMinutes: z.number().int().positive().max(1440).default(60),
      botToken: z.string().optional(),
    }).parse(request.body);
    const existing = await deps.store.getTelegramConfig();
    let botSecretId = existing?.botSecretId ?? null;
    if (body.botToken) botSecretId = await storeCredential(deps, "telegram bot", body.botToken);
    const saved = await deps.store.saveTelegramConfig({
      enabled: body.enabled,
      chatId: body.chatId,
      minSeverity: body.minSeverity,
      digestMinutes: body.digestMinutes,
      botSecretId,
      lastDigestAt: existing?.lastDigestAt ?? null,
    });
    return publicTelegram(deps, saved.botSecretId);
  });
  app.post("/api/telegram/pair", async (request, reply) => {
    const config = await deps.store.getTelegramConfig();
    const secret = config?.botSecretId ? await deps.store.getSecret(config.botSecretId) : null;
    if (!secret) return reply.code(400).send({ error: "Save a bot token before pairing" });
    const botToken = decryptSecret(secret, deps.env.APP_MASTER_KEY);
    let username = "";
    try {
      username = (await telegramBotProfile(botToken, deps.fetchImpl)).username;
    } catch {
      return reply.code(502).send({ error: "Telegram did not accept the saved bot token" });
    }
    const sessionToken = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString();
    await deps.pairing.save({ token: sessionToken, status: "pending", chatId: "", botUsername: username, expiresAt });
    const url = telegramDeepLink(username, sessionToken);
    const svg = (await QRCode.toString(url, { type: "svg", margin: 1, width: 220, color: { dark: "#0f172a", light: "#ffffff" } })).replace(/<\?xml[^>]*>/, "");
    await audit(deps, request.userId, "telegram.pair", "default");
    return { token: sessionToken, botUsername: username, url, expiresAt, svg };
  });
  app.get("/api/telegram/pair/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const session = /^[a-f0-9]{32}$/.test(token) ? await deps.pairing.get(token) : null;
    if (!session) return reply.code(404).send({ error: "pairing session not found" });
    return { status: session.status, chatId: session.chatId, enabled: session.status === "paired" };
  });
  app.post("/api/telegram/test", async (_request, reply) => {
    const config = await deps.store.getTelegramConfig();
    const secret = config?.botSecretId ? await deps.store.getSecret(config.botSecretId) : null;
    if (!secret || !config?.chatId) return reply.code(400).send({ error: "Save a bot token and chat id before sending a test alert" });
    try {
      await sendTelegramMessage(decryptSecret(secret, deps.env.APP_MASTER_KEY), config.chatId, "Agent Platform test alert", deps.fetchImpl);
    } catch {
      return reply.code(502).send({ error: "Telegram did not accept the test alert" });
    }
    await deps.store.addNotification({
      id: newId(),
      agentId: null,
      taskId: null,
      severity: "info",
      title: "Test alert",
      body: "Sent to the paired Telegram chat.",
      links: [],
      delivered: true,
      createdAt: nowIso(),
    });
    return { sent: true };
  });
  app.get("/api/notifications", async () => deps.store.listNotifications(50));
  app.get("/api/audit", async () => deps.store.listAudit(50));

  app.post("/api/integrations/trello/boards", async (request) => {
    const body = z.object({ key: z.string().min(1), token: z.string().min(1) }).parse(request.body);
    return listTrelloBoards(body, deps.fetchImpl);
  });
  app.post("/api/integrations/github/projects", async (request) => {
    const body = z.object({ token: z.string().min(1), owner: z.string().min(1), repo: z.string().min(1) }).parse(request.body);
    return listGithubProjects(body.token, body.owner, body.repo, deps.fetchImpl);
  });

  return app;
}

function normalizeLinked(primaryName: string, primaryUrl: string, linked: string[]): string[] {
  const primary = parseRepositoryRef(primaryName) ?? parseRepositoryRef(primaryUrl);
  const seen = new Set<string>();
  if (primary) seen.add(primary.name.toLowerCase());
  const names: string[] = [];
  for (const item of linked) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parsed = parseRepositoryRef(trimmed, primary?.host ?? "github", primary?.host === "gitlab" ? new URL(primary.url).origin : "");
    if (!parsed) throw new ConfigError("Linked repositories use owner/name or an https URL");
    const key = parsed.name.toLowerCase();
    if (seen.has(key)) throw new ConfigError("A linked repository is duplicated or matches the primary repository");
    seen.add(key);
    names.push(parsed.name);
  }
  return names;
}

function customSkillId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill";
  let id = `custom-${base}`;
  let suffix = 2;
  while (taken.includes(id)) {
    id = `custom-${base}-${suffix}`;
    suffix += 1;
  }
  return id.slice(0, 64);
}

function idParam(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

async function requireAgent(deps: ServerDeps, request: FastifyRequest, reply: FastifyReply): Promise<Agent | null> {
  const agent = await deps.store.getAgent(idParam(request));
  if (!agent) {
    reply.code(404).send({ error: "agent not found" });
    return null;
  }
  return agent;
}

async function createAgent(deps: ServerDeps, body: z.infer<typeof CreateAgent>, actor: string): Promise<Agent> {
  const id = newId();
  const timestamp = nowIso();
  const source = body.boardName || body.repositoryName || body.repositoryUrl || "Project";
  const agent: Agent = {
    id,
    name: body.name?.trim() || defaultAgentName(source),
    description: body.description,
    status: "created",
    repositoryUrl: body.repositoryUrl,
    repositoryName: body.repositoryName,
    linkedRepositories: normalizeLinked(body.repositoryName, body.repositoryUrl, body.linkedRepositories),
    defaultBranch: body.defaultBranch,
    provider: body.provider,
    boardId: body.boardId,
    boardName: body.boardName,
    workspacePath: path.join(deps.env.WORKSPACES_DIR, id),
    executorKind: body.executorKind,
    dailyCapacityHours: body.dailyCapacityHours,
    allowOverCapacity: body.allowOverCapacity,
    credentialSecretId: await storedBoardCredential(deps, `${source} credential`, boardCredential(body.provider, body.credential, body.boardKey, body.boardToken, { key: "", token: "" })),
    telegramChatId: body.telegramChatId,
    rules: defaultRules(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await mkdir(agent.workspacePath, { recursive: true });
  await deps.store.insertAgent(agent);
  await deps.store.saveWorkflow({
    id: newId(),
    agentId: id,
    name: "Default",
    columns: DEFAULT_COLUMNS,
    selection: DEFAULT_SELECTION_RULES,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await deps.store.saveScheduler(emptyScheduler(id));
  await audit(deps, actor, "agent.create", id);
  return agent;
}

async function storeCredential(deps: ServerDeps, name: string, value: string): Promise<string> {
  const encrypted = encryptSecret(value, deps.env.APP_MASTER_KEY);
  const secret: StoredSecret = {
    id: newId(),
    name,
    ...encrypted,
    hint: secretHint(value),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await deps.store.putSecret(secret);
  return secret.id;
}

async function publicProvider(deps: ServerDeps, provider: ProviderRecord) {
  const secret = provider.secretId ? await deps.store.getSecret(provider.secretId) : null;
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    costClass: provider.costClass,
    enabled: provider.enabled,
    credential: { configured: Boolean(secret), hint: secret?.hint ?? "" },
  };
}

async function publicTelegram(deps: ServerDeps, secretId?: string | null) {
  const config = await deps.store.getTelegramConfig();
  const id = secretId === undefined ? config?.botSecretId : secretId;
  const secret = id ? await deps.store.getSecret(id) : null;
  return {
    enabled: config?.enabled ?? false,
    chatId: config?.chatId ?? "",
    minSeverity: config?.minSeverity ?? "warning",
    digestMinutes: config?.digestMinutes ?? 60,
    credential: { configured: Boolean(secret), hint: secret?.hint ?? "" },
  };
}

async function refreshBoardTasks(deps: ServerDeps, agent: Agent): Promise<{ tasks: Task[]; boardError: string | null; notices: { taskId: string; message: string }[] }> {
  let credentials = { key: "", token: "" };
  try {
    credentials = await credentialsFor(deps, agent);
  } catch {
    return { tasks: await deps.store.listTasks(agent.id), boardError: "Board credentials could not be read.", notices: [] };
  }
  return refreshStoredBoard(deps.store, agent, credentials, deps.fetchImpl);
}

async function ensureTrelloWebhook(deps: ServerDeps, agent: Agent): Promise<void> {
  const origin = deps.env.APP_PUBLIC_URL.trim().replace(/\/$/, "");
  if (agent.provider !== "trello" || !agent.boardId || !origin) return;
  let credentials = { key: "", token: "" };
  try {
    credentials = await credentialsFor(deps, agent);
  } catch {
    return;
  }
  const result = await registerTrelloWebhook(credentials, agent.boardId, `${origin}/api/webhooks/trello`, deps.fetchImpl).catch(() => ({ ok: false as const, error: "Trello webhook was not registered." }));
  if (!result.ok) {
    await deps.store.addEvent({
      id: newId(),
      agentId: agent.id,
      taskId: null,
      kind: "board",
      message: result.error,
      metadata: {},
      createdAt: nowIso(),
    });
  }
}

async function applyTrelloMove(deps: ServerDeps, body: unknown): Promise<void> {
  const move = readTrelloCardMove(body);
  if (!move) return;
  const agents = (await deps.store.listAgents()).filter((agent) => agent.provider === "trello" && agent.boardId === move.boardId);
  for (const agent of agents) {
    const workflow = await deps.store.getWorkflow(agent.id);
    if (!workflow) continue;
    let listName = move.listName;
    if (!listName) {
      try {
        const credentials = await credentialsFor(deps, agent);
        if (credentials.key && credentials.token) {
          const lists = await listTrelloLists(credentials, agent.boardId, deps.fetchImpl);
          listName = lists.find((list) => list.id === move.listId)?.name ?? "";
        }
      } catch {
        listName = "";
      }
    }
    if (!listName) continue;
    const local = await deps.store.listTasks(agent.id);
    const existing = local.find((task) => task.externalId === move.cardId);
    const merged = mergeCards(agent.id, local, [{
      externalId: move.cardId,
      title: move.cardName || existing?.title || "Trello card",
      description: existing?.description ?? "",
      acceptanceCriteria: existing?.acceptanceCriteria ?? "",
      columnName: listName,
      url: existing?.url ?? "",
      comments: existing?.comments ?? [],
      labels: existing?.labels ?? [],
      dueAt: existing?.dueAt ?? null,
      priority: existing?.priority ?? 3,
    }], workflow.columns);
    for (const task of merged.tasks) {
      const before = local.find((item) => item.id === task.id);
      if (!before || before.stage !== task.stage || before.title !== task.title) await deps.store.saveTask(task);
    }
    for (const approval of merged.approvals) {
      await deps.store.createApproval({
        id: newId(),
        taskId: approval.taskId,
        agentId: agent.id,
        source: approval.reason.includes("imported") ? "import" : "board",
        decision: "approved",
        actor: "board",
        comment: approval.reason,
        createdAt: nowIso(),
      });
    }
  }
}

function boardCredential(provider: string, credential: string | undefined, boardKey: string | undefined, boardToken: string | undefined, current: { key: string; token: string }): string | null {
  const key = boardKey?.trim() || current.key;
  const token = boardToken?.trim() || current.token;
  if ((boardKey?.trim() || boardToken?.trim()) && provider === "trello") return JSON.stringify({ key, token });
  if (boardToken?.trim()) return boardToken.trim();
  if (credential?.trim()) return credential.trim();
  return null;
}

async function storedBoardCredential(deps: ServerDeps, name: string, value: string | null): Promise<string | null> {
  if (!value) return null;
  return storeCredential(deps, name, value);
}

async function currentBoardCredential(deps: ServerDeps, agent: Agent): Promise<{ key: string; token: string }> {
  if (!agent.credentialSecretId) return { key: "", token: "" };
  const secret = await deps.store.getSecret(agent.credentialSecretId);
  if (!secret) return { key: "", token: "" };
  try {
    return parseCredentials(decryptSecret(secret, deps.env.APP_MASTER_KEY), agent.provider);
  } catch {
    return { key: "", token: "" };
  }
}

async function credentialsFor(deps: ServerDeps, agent: Agent): Promise<{ key: string; token: string }> {
  if (!agent.credentialSecretId) return { key: "", token: "" };
  const secret = await deps.store.getSecret(agent.credentialSecretId);
  if (!secret) return { key: "", token: "" };
  return parseCredentials(decryptSecret(secret, deps.env.APP_MASTER_KEY), agent.provider);
}

async function decide(deps: ServerDeps, request: FastifyRequest, reply: FastifyReply, decision: "approved" | "rejected") {
  const task = await deps.store.getTask(idParam(request));
  if (!task) return reply.code(404).send({ error: "task not found" });
  const comment = z.object({ comment: z.string().default("") }).parse(request.body ?? {});
  if (task.stage !== "review") {
    if (decision === "approved") approveTask(task, { source: "ui" });
    else rejectTask(task, comment.comment || "rejected");
  }
  const agent = await deps.store.getAgent(task.agentId);
  let mergedInto: string | null = null;
  if (decision === "approved") {
    const urls = task.prUrl.split(/\s+/).filter(Boolean);
    if (urls.length > 0) {
      const token = await repositoryToken(deps, agent);
      if (!token) return reply.code(409).send({ error: "Save a GitHub or GitLab token before merging this pull request into develop." });
      try {
        const merged = await mergeApprovedChanges({ token, urls, base: agent?.defaultBranch || "develop", fetchImpl: deps.fetchImpl });
        mergedInto = merged.base;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The pull request was not merged.";
        return reply.code(409).send({ error: message });
      }
    }
  }
  const next = decision === "approved" ? approveTask(task, { source: "ui" }) : rejectTask(task, comment.comment || "rejected");
  await deps.store.createApproval({
    id: newId(),
    taskId: task.id,
    agentId: task.agentId,
    source: "ui",
    decision,
    actor: request.userId ?? "admin",
    comment: comment.comment,
    createdAt: nowIso(),
  });
  await deps.store.saveTask(next);
  const workflow = agent ? await deps.store.getWorkflow(agent.id) : null;
  if (agent && workflow) {
    const board = createBoardClient({
      provider: agent.provider,
      boardId: agent.boardId,
      credentials: await credentialsFor(deps, agent),
      fetchImpl: deps.fetchImpl,
    });
    const column = columnForStage(workflow.columns, next.stage);
    if (board && column) await board.moveCard(next.externalId, column).catch(() => undefined);
  }
  await publishDecision(deps, agent, next, decision, mergedInto);
  await audit(deps, request.userId, `task.${decision}`, task.id);
  return { ...next, mergedInto };
}

async function repositoryToken(deps: ServerDeps, agent: Agent | null): Promise<string> {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITLAB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  if (!agent || agent.provider !== "github_projects") return "";
  return (await credentialsFor(deps, agent)).token;
}

async function publishDecision(deps: ServerDeps, agent: Agent | null, task: Task, decision: "approved" | "rejected", mergedInto: string | null): Promise<void> {
  const title = mergedInto ? "Pull request merged" : decision === "approved" ? "Task approved" : "Rework requested";
  const body = formatNotification({
    agentName: agent?.name ?? "Agent",
    repository: agent?.repositoryName || "unassigned",
    taskTitle: task.title,
    status: task.stage,
    severity: "info",
    title,
    action: mergedInto ? `Merged into ${mergedInto}` : decision === "approved" ? "Approved" : "Rejected",
    body: mergedInto
      ? `${task.title} was approved and the pull request was merged into ${mergedInto}.`
      : decision === "approved"
        ? `${task.title} was approved and moved to Done.`
        : `${task.title} was sent back for re-work.`,
    links: task.prUrl.split(/\s+/).filter(Boolean).map((url) => ({ label: "Pull request", url })),
  });
  let delivered = false;
  const config = await deps.store.getTelegramConfig();
  const secret = config?.botSecretId ? await deps.store.getSecret(config.botSecretId) : null;
  if (secret && config?.enabled && config.chatId) {
    try {
      await sendTelegramMessage(decryptSecret(secret, deps.env.APP_MASTER_KEY), config.chatId, body, deps.fetchImpl);
      delivered = true;
    } catch {
      delivered = false;
    }
  }
  await deps.store.addNotification({
    id: newId(),
    agentId: task.agentId,
    taskId: task.id,
    severity: delivered ? "info" : "warning",
    title,
    body,
    links: task.prUrl.split(/\s+/).filter(Boolean).map((url) => ({ label: "Pull request", url })),
    delivered,
    createdAt: nowIso(),
  });
}

function providerKeyFromEnv(env: PlatformEnv, type: string): string {
  if (type === "cursor") return env.CURSOR_API_KEY;
  if (type === "openai" || type === "codex") return env.OPENAI_API_KEY || env.CODEX_API_KEY;
  return "";
}

async function probeProvider(deps: ServerDeps, provider: ProviderRecord) {
  if (provider.type === "codex") {
    const { spawn } = await import("node:child_process");
    const available = await new Promise<boolean>((resolve) => {
      const child = spawn("codex", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    return { available, costClass: provider.costClass, detail: available ? "Codex CLI responded" : "Codex CLI is not installed" };
  }
  if (provider.type === "cursor") {
    const secret = provider.secretId ? await deps.store.getSecret(provider.secretId) : null;
    return { available: Boolean(secret), costClass: provider.costClass, detail: secret ? "Cursor API key is configured" : "Cursor API key is missing" };
  }
  if (!provider.baseUrl) return { available: false, costClass: provider.costClass, detail: "base URL is empty" };
  try {
    const response = await (deps.fetchImpl ?? fetch)(provider.baseUrl.replace(/\/$/, "") + "/models");
    return { available: response.ok, costClass: provider.costClass, detail: `status ${response.status}` };
  } catch {
    return { available: false, costClass: provider.costClass, detail: "provider did not respond" };
  }
}

async function dashboard(deps: ServerDeps) {
  const [agents, tasks, notifications, usage, heartbeat, events] = await Promise.all([
    deps.store.listAgents(),
    deps.store.listTasks(),
    deps.store.listNotifications(20),
    deps.store.usageSince(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    deps.store.getHeartbeat("worker"),
    deps.store.listEvents(undefined, 20),
  ]);
  const count = (status: string) => agents.filter((agent) => agent.status === status).length;
  const stages = (stage: string) => tasks.filter((task) => task.stage === stage).length;
  const usageByModel = new Map<string, { modelId: string; costClass: string; tokens: number }>();
  for (const entry of usage) {
    const current = usageByModel.get(entry.modelId) ?? { modelId: entry.modelId, costClass: entry.costClass, tokens: 0 };
    current.tokens += entry.tokensIn + entry.tokensOut;
    usageByModel.set(entry.modelId, current);
  }
  return {
    agents: {
      total: agents.length,
      running: count("running"),
      paused: count("paused"),
      stopped: count("stopped"),
      error: count("error"),
      created: count("created"),
    },
    tasks: {
      active: stages("doing"),
      queued: stages("backlog") + stages("planning") + stages("todo"),
      completed: stages("done"),
      failed: stages("failed"),
      blocked: stages("blocked"),
      review: stages("review"),
    },
    recentActivity: events,
    usage: [...usageByModel.values()],
    alerts: notifications.filter((item) => item.severity !== "info").slice(0, 10),
    resources: heartbeat?.payload ?? { runtimeMode: "unknown", rssMb: 0 },
    workerSeenAt: heartbeat?.updatedAt ?? null,
    exampleMasterKey: masterKeyIsExample(deps.env.APP_MASTER_KEY),
  };
}

async function audit(deps: ServerDeps, actor: string | undefined, action: string, targetId: string) {
  await deps.store.addAudit({
    id: newId(),
    actor: actor ?? "system",
    action,
    targetType: action.split(".")[0] ?? "platform",
    targetId,
    metadata: {},
    createdAt: nowIso(),
  });
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
  }
}
