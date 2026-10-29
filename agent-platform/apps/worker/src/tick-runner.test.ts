import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessRuntime, approveTask, resolveInWorkspace } from "@agent-platform/core";
import { MemoryStore } from "@agent-platform/db";
import { DEFAULT_COLUMNS, DEFAULT_SELECTION_RULES, defaultRules, emptyScheduler, newId, nowIso, type Agent } from "@agent-platform/shared";
import { handleTelegramCommand } from "./commands.js";
import { executeTick } from "./tick-runner.js";

const masterKey = "0123456789abcdef0123456789abcdef";

function makeAgent(workspace: string, id = newId()): Agent {
  return {
    id,
    name: "Repo Agent",
    description: "",
    status: "running",
    repositoryUrl: "",
    repositoryName: "acme/repo",
    linkedRepositories: [],
    defaultBranch: "main",
    provider: "none",
    boardId: "",
    boardName: "Repo",
    workspacePath: workspace,
    executorKind: "fake",
    dailyCapacityHours: 8,
    allowOverCapacity: false,
    credentialSecretId: null,
    telegramChatId: "",
    rules: { ...defaultRules(), allowEmptyChecks: true, validationCommands: [] },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe("worker tick", () => {
  it("implements a local task through review and requires approval for done", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-e2e-"));
    const other = await mkdtemp(path.join(tmpdir(), "agent-other-"));
    const store = new MemoryStore();
    const agent = makeAgent(workspace);
    await store.insertAgent(agent);
    await store.saveWorkflow({
      id: newId(),
      agentId: agent.id,
      name: "Default",
      columns: DEFAULT_COLUMNS,
      selection: DEFAULT_SELECTION_RULES,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await store.saveScheduler(emptyScheduler(agent.id));
    await store.saveTask({
      id: newId(),
      agentId: agent.id,
      externalId: "card-1",
      title: "Add note",
      description: "Write NOTE content",
      acceptanceCriteria: "file exists",
      comments: [],
      url: "",
      stage: "backlog",
      priority: 1,
      estimateHours: 1,
      dependsOn: [],
      dueAt: null,
      plan: "",
      branchName: "",
      prUrl: "",
      blockedReason: "",
      exceptionNote: "",
      checksPassed: false,
      labels: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const runtime = new ProcessRuntime();
    const result = await executeTick({ store, agentId: agent.id, runtime, masterKey });
    expect(result.action).toBe("review");
    const tasks = await store.listTasks(agent.id);
    expect(tasks[0]?.stage).toBe("review");
    expect(tasks.some((task) => task.stage === "done")).toBe(false);
    const memories = await store.listMemories(agent.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.title).toBe("Add note");
    expect(memories[0]?.body).toContain("Stay on ticket");
    expect(memories[0]?.revision).toBeGreaterThan(1);
    const approved = approveTask(tasks[0]!, { source: "ui" });
    expect(approved.stage).toBe("done");
    expect(() => resolveInWorkspace(other, path.join(workspace, "AGENT_WORK.md"))).toThrow(/escapes workspace/);
    const reply = await handleTelegramCommand(store, "/approve not-a-task", masterKey);
    expect(reply).toMatch(/not found/i);
  });

  it("answers project questions in Telegram and stays on the project", async () => {
    const store = new MemoryStore();
    const agent = makeAgent("/tmp/agent-chat");
    agent.name = "Billing Agent";
    agent.repositoryName = "acme/billing";
    await store.insertAgent(agent);
    const other = makeAgent("/tmp/agent-chat-2");
    other.name = "BitVox";
    other.repositoryName = "biteon-ai/bitvox-core";
    await store.insertAgent(other);
    await store.saveTask({
      id: newId(),
      agentId: agent.id,
      externalId: "card-9",
      title: "Add invoice export",
      description: "Export invoices",
      acceptanceCriteria: "",
      comments: [],
      url: "",
      stage: "doing",
      priority: 1,
      estimateHours: 1,
      dependsOn: [],
      dueAt: null,
      plan: "",
      branchName: "",
      prUrl: "",
      blockedReason: "",
      exceptionNote: "",
      checksPassed: false,
      labels: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const status = await handleTelegramCommand(store, "what are you doing", masterKey);
    expect(status).toContain("Add invoice export");
    expect(status).toContain("acme/billing");
    expect(status).toContain("BitVox");
    expect(status).not.toContain("/pause");
    const named = await handleTelegramCommand(store, "what is Billing Agent doing", masterKey);
    expect(named).toContain("Working on");
    expect(named).not.toContain("BitVox");
    expect(await handleTelegramCommand(store, "Hi", masterKey)).toContain("backlog");
    expect(await handleTelegramCommand(store, "list the backlog", masterKey)).toContain("No tickets in Backlog");
    expect(await handleTelegramCommand(store, "what has been done", masterKey)).toContain("No tickets in Done");
    expect(await handleTelegramCommand(store, "any problems", masterKey)).toContain("No blocked");
    const queued: string[] = [];
    expect(await handleTelegramCommand(store, "restart Billing Agent", masterKey, { enqueue: async (agentId) => { queued.push(agentId); } })).toContain("restarted");
    expect(queued).toContain(agent.id);
    expect(await handleTelegramCommand(store, "start", masterKey)).toContain("Which agent and project");
    expect(await handleTelegramCommand(store, "commands", masterKey)).toContain("/start");
    expect(await handleTelegramCommand(store, "commands", masterKey)).toContain("acme/billing");
    const pushed: string[] = [];
    expect(await handleTelegramCommand(store, "push BitVox", masterKey, { enqueue: async (agentId) => { pushed.push(agentId); } })).toContain("pushed to work");
    expect(pushed).toContain(other.id);
    expect(await handleTelegramCommand(store, "stop", masterKey)).toContain("Which agent and project");
    expect(await handleTelegramCommand(store, "/stop Billing Agent", masterKey)).toContain("Billing Agent is stopped");
    expect((await store.getAgent(agent.id))?.status).toBe("stopped");
    const ticked: string[] = [];
    expect(await handleTelegramCommand(store, "/tick BitVox", masterKey, { enqueue: async (agentId) => { ticked.push(agentId); } })).toContain("queued for a tick");
    expect(ticked).toContain(other.id);
    expect((await store.getAgent(other.id))?.status).toBe("running");
    expect(await handleTelegramCommand(store, "/sync BitVox", masterKey)).toContain("no board to sync");
    expect(await handleTelegramCommand(store, "commands", masterKey)).toContain("/stop");
    expect(await handleTelegramCommand(store, "commands", masterKey)).toContain("/tick");
    expect(await handleTelegramCommand(store, "commands", masterKey)).toContain("/sync");
    expect(await handleTelegramCommand(store, "tell me a joke", masterKey)).toContain("only talk about this project");
    expect(await handleTelegramCommand(store, "work on Add invoice export", masterKey)).toContain("Already working");
  });

  it("keeps a task in progress when validation fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-fail-"));
    const store = new MemoryStore();
    const agent = makeAgent(workspace);
    agent.rules = { ...agent.rules, allowEmptyChecks: false, validationCommands: [["node", "-e", "process.exit(1)"]] };
    await store.insertAgent(agent);
    await store.saveWorkflow({
      id: newId(),
      agentId: agent.id,
      name: "Default",
      columns: DEFAULT_COLUMNS,
      selection: DEFAULT_SELECTION_RULES,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await store.saveScheduler(emptyScheduler(agent.id));
    const taskId = newId();
    await store.saveTask({
      id: taskId,
      agentId: agent.id,
      externalId: "card-2",
      title: "Broken check",
      description: "should fail",
      acceptanceCriteria: "",
      comments: [],
      url: "",
      stage: "todo",
      priority: 1,
      estimateHours: 1,
      dependsOn: [],
      dueAt: null,
      plan: "",
      branchName: "",
      prUrl: "",
      blockedReason: "",
      exceptionNote: "",
      checksPassed: false,
      labels: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const result = await executeTick({ store, agentId: agent.id, runtime: new ProcessRuntime(), masterKey });
    expect(result.action).toBe("failed");
    expect((await store.getTask(taskId))?.stage).toBe("doing");
  });
});
