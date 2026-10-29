import { spawn } from "node:child_process";
import path from "node:path";
import {
  DockerRuntime,
  ProcessRuntime,
  checkoutPath,
  decryptSecret,
  executorForProvider,
  formatNotification,
  isTokenLimitError,
  routeModel,
  scopeMemoryBody,
  guardAgentMerges,
  runAgentTick,
  startOfUtcDay,
  workspaceCheckouts,
  type AgentRuntime,
  type TickResult,
} from "@agent-platform/core";
import type { PlatformStore } from "@agent-platform/db";
import { CodexExecutor, CursorSdkExecutor, FakeExecutor, LlmToolExecutor, OpenAiChatClient } from "@agent-platform/executors";
import { WorkspaceGit, createBoardClient, parseCredentials } from "@agent-platform/integrations";
import { newId, nowIso, type Agent, type NotificationRecord, type TaskRun } from "@agent-platform/shared";

export async function executeTick(input: {
  store: PlatformStore;
  agentId: string;
  runtime: AgentRuntime;
  masterKey: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<TickResult> {
  const agent = await input.store.getAgent(input.agentId);
  if (!agent) return { action: "missing" };
  const runtime = guardAgentMerges(input.runtime, async () => {
    const tasks = await input.store.listTasks(agent.id);
    for (const task of tasks) {
      const approval = await input.store.latestApproval(task.id);
      if (approval?.decision === "approved" && (approval.source === "ui" || approval.source === "telegram")) return approval;
    }
    return null;
  });
  const workflow = await input.store.getWorkflow(agent.id);
  if (!workflow) return { action: "missing", detail: "workflow" };
  const now = input.now ?? new Date();
  await runtime.ensure(agent);
  const credentials = await readCredentials(input.store, agent, input.masterKey);
  const board = createBoardClient({
    provider: agent.provider,
    boardId: agent.boardId,
    credentials,
    fetchImpl: input.fetchImpl,
  });
  const gitClient = new WorkspaceGit(runtime);
  const choice = await chooseExecutor(input, agent, now, runtime);
  if ("error" in choice) {
    const limit = isTokenLimitError(choice.error);
    await notify(input.store, agent.id, null, {
      agentName: agent.name,
      repository: agent.repositoryName,
      status: agent.status,
      severity: "urgent",
      title: limit ? "Paid model has no tokens left" : "No model available",
      body: limit ? `${choice.error} Ask “tokens left” to check the paid models in use.` : choice.error,
      action: limit ? "Add tokens or switch the primary model." : "Adjust the model assignment, budget, or provider.",
    });
    return { action: "blocked", detail: choice.error };
  }
  const scheduler = (await input.store.getScheduler(agent.id)) ?? {
    agentId: agent.id,
    lastPlanAt: null,
    lastTickAt: null,
    activeRunId: null,
    retryAt: null,
    consecutiveFailures: 0,
  };
  const result = await runAgentTick({
    now,
    agent,
    workflow,
    tasks: await input.store.listTasks(agent.id),
    memories: await input.store.listMemories(agent.id),
    scheduler,
    board,
    model: choice.model,
    executor: choice.executor,
    git: {
      prepare: (current, task, owned) => gitClient.prepare(current, task, owned, credentials.token),
      commitAndPush: (current, task, owned, message) => gitClient.commitAndPush(current, task, owned, message, credentials.token),
    diff: (current) => gitClient.diff(current),
    conflictCheck: (current, baseBranch) => gitClient.conflictCheck(current, baseBranch),
  },
    notify: async (draft) => {
      const taskId = draft.taskTitle ? (await input.store.listTasks(agent.id)).find((task) => task.title === draft.taskTitle)?.id ?? null : null;
      await notify(input.store, agent.id, taskId, draft);
    },
    saveTask: async (task) => {
      await input.store.saveTask(task);
    },
    saveScheduler: async (state) => {
      await input.store.saveScheduler(state);
    },
    createRun: async (run) => {
      await input.store.createRun(run);
    },
    updateRun: async (run) => {
      await input.store.updateRun(run);
      await recordUsage(input.store, run);
    },
    saveCheckpoint: async (checkpoint) => {
      await input.store.saveCheckpoint(checkpoint);
    },
    latestCheckpoint: (runId) => input.store.latestCheckpoint(runId),
    findRun: (runId) => input.store.findRun(runId),
    remember: async ({ task, phase, note }) => {
      const ref = `task:${task.id}`;
      const body = scopeMemoryBody(task, phase, note);
      const existing = (await input.store.listMemories(agent.id)).find((memory) => memory.sourceRefs.includes(ref));
      const timestamp = nowIso();
      const sourceRefs = [...new Set([ref, task.externalId, task.prUrl].filter(Boolean))];
      if (!existing) {
        return input.store.createMemory({
          id: newId(),
          agentId: agent.id,
          kind: /fix|bug/i.test(task.title) ? "bug" : "feature",
          title: task.title,
          body,
          sourceRefs,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return input.store.reviseMemory({
        ...existing,
        title: task.title,
        body,
        sourceRefs: [...new Set([...existing.sourceRefs, ...sourceRefs])],
        revision: existing.revision + 1,
        updatedAt: timestamp,
      });
    },
    recordApproval: async (taskId, source, comment) => {
      await input.store.createApproval({
        id: newId(),
        taskId,
        agentId: agent.id,
        source,
        decision: "approved",
        actor: source,
        comment,
        createdAt: nowIso(),
      });
    },
    runValidation: (commands) => validate(input.runtime, agent, commands),
  });
  await input.store.addEvent({
    id: newId(),
    agentId: agent.id,
    taskId: result.taskId ?? null,
    kind: "tick",
    message: `${result.action}${result.detail ? `: ${result.detail}` : ""}`,
    metadata: {},
    createdAt: nowIso(),
  });
  return result;
}

async function chooseExecutor(input: { store: PlatformStore; runtime: AgentRuntime; masterKey: string; agentId: string }, agent: Agent, now: Date, runtime: AgentRuntime) {
  if (agent.executorKind === "fake") {
    return { executor: new FakeExecutor(), model: undefined };
  }
  const [assignments, models, providers, usage] = await Promise.all([
    input.store.listAssignments(),
    input.store.listModels(),
    input.store.listProviders(),
    input.store.usageSince(startOfUtcDay(now).toISOString()),
  ]);
  const usageTokensByModel: Record<string, number> = {};
  for (const entry of usage) usageTokensByModel[entry.modelId] = (usageTokensByModel[entry.modelId] ?? 0) + entry.tokensIn + entry.tokensOut;
  const routed = routeModel({ activity: "coding", agentId: agent.id, assignments, models, providers, usageTokensByModel });
  if ("error" in routed) return routed;
  const secret = routed.provider.secretId ? await input.store.getSecret(routed.provider.secretId) : null;
  const apiKey = secret ? decryptSecret(secret, input.masterKey) : "";
  const model = {
    id: routed.model.id,
    modelId: routed.model.modelId,
    costClass: routed.model.costClass,
    baseUrl: routed.provider.baseUrl,
    apiKey,
    providerType: routed.provider.type,
  };
  const kind = executorForProvider(routed.provider.type);
  if (kind === "cursor") return { executor: new CursorSdkExecutor(), model };
  if (kind === "codex") {
    return {
      executor: new CodexExecutor({
        async available() {
          const result = await spawnCommand("codex", ["--version"], agent.workspacePath, {}, 10000);
          return result.code === 0;
        },
        exec: (workspace, args, env, timeoutMs) => spawnCommand("codex", args, workspace, env, timeoutMs),
      }),
      model,
    };
  }
  return { executor: new LlmToolExecutor(new OpenAiChatClient(), runtime), model };
}

async function validate(runtime: AgentRuntime, agent: Agent, commands: string[][]) {
  if (commands.length === 0) return { passed: true, detail: "no validation commands configured" };
  const checkouts = workspaceCheckouts(agent);
  const roots = checkouts.length > 0
    ? checkouts.map((checkout) => checkoutPath(agent.workspacePath, checkout.directory))
    : [agent.workspacePath];
  const details: string[] = [];
  for (const root of roots) {
    const label = path.relative(agent.workspacePath, root) || ".";
    for (const argv of commands) {
      const [file, ...args] = argv;
      if (!file) return { passed: false, detail: "empty validation command" };
      try {
        const result = await runtime.exec(agent.id, file, args, { hostCwd: root, timeoutMs: 120000 });
        details.push(`${label}: ${argv.join(" ")} exited ${result.code}`);
        if (result.code !== 0) return { passed: false, detail: details.join("; ") };
      } catch (error) {
        return { passed: false, detail: error instanceof Error ? error.message : "validation command rejected" };
      }
    }
  }
  return { passed: true, detail: details.join("; ") };
}

async function recordUsage(store: PlatformStore, run: TaskRun) {
  if (!run.finishedAt || run.costClass === "none") return;
  await store.addUsage({
    id: newId(),
    agentId: run.agentId,
    modelId: run.modelId || "unknown",
    activity: run.activity,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costClass: run.costClass,
    createdAt: run.finishedAt,
  });
}

async function readCredentials(store: PlatformStore, agent: Agent, masterKey: string) {
  if (!agent.credentialSecretId) return { key: "", token: "" };
  const secret = await store.getSecret(agent.credentialSecretId);
  if (!secret) return { key: "", token: "" };
  return parseCredentials(decryptSecret(secret, masterKey), agent.provider);
}

async function notify(store: PlatformStore, agentId: string, taskId: string | null, draft: Parameters<typeof formatNotification>[0]) {
  if (draft.title === "Paid model has no tokens left") {
    const recent = await store.listNotifications(40);
    const already = recent.some((item) => item.agentId === agentId && item.title === draft.title && Date.now() - Date.parse(item.createdAt) < 60 * 60 * 1000);
    if (already) return;
  }
  const notification: NotificationRecord = {
    id: newId(),
    agentId,
    taskId,
    severity: draft.severity,
    title: draft.title,
    body: formatNotification(draft),
    links: draft.links ?? [],
    delivered: false,
    createdAt: nowIso(),
  };
  await store.addNotification(notification);
  await store.addEvent({
    id: newId(),
    agentId,
    taskId,
    kind: "notification",
    message: draft.title,
    metadata: { severity: draft.severity },
    createdAt: notification.createdAt,
  });
}

function spawnCommand(file: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export function runtimeFromEnv(env: { DOCKER_RUNTIME: string; AGENT_RUNTIME_IMAGE: string; AGENT_DOCKER_NETWORK: string; AGENT_CONTAINER_MEMORY: string; AGENT_CONTAINER_CPUS: string }): AgentRuntime {
  if (env.DOCKER_RUNTIME === "true") {
    return new DockerRuntime({
      image: env.AGENT_RUNTIME_IMAGE,
      network: env.AGENT_DOCKER_NETWORK,
      memory: env.AGENT_CONTAINER_MEMORY,
      cpus: env.AGENT_CONTAINER_CPUS,
    });
  }
  return new ProcessRuntime();
}
