import { describe, expect, it } from "vitest";
import { encryptSecret } from "@agent-platform/core";
import { MemoryStore } from "@agent-platform/db";
import { DEFAULT_COLUMNS, DEFAULT_SELECTION_RULES, defaultRules, emptyScheduler, newId, nowIso, type Agent } from "@agent-platform/shared";
import { syncConnectedBoards } from "./board-poll.js";

const masterKey = "0123456789abcdef0123456789abcdef";

describe("trello board poll", () => {
  it("refreshes connected Trello boards", async () => {
    const store = new MemoryStore();
    const sealed = encryptSecret(JSON.stringify({ key: "trello-key", token: "trello-token" }), masterKey);
    const secretId = newId();
    await store.putSecret({ id: secretId, name: "trello", ...sealed, hint: "••••", createdAt: nowIso(), updatedAt: nowIso() });
    const agent: Agent = {
      id: newId(),
      name: "BitVox",
      description: "",
      status: "running",
      repositoryUrl: "",
      repositoryName: "acme/repo",
      linkedRepositories: [],
      defaultBranch: "main",
      provider: "trello",
      boardId: "board-1",
      boardName: "BitVox",
      workspacePath: "/tmp/board-poll",
      executorKind: "fake",
      dailyCapacityHours: 8,
      allowOverCapacity: false,
      credentialSecretId: secretId,
    repositorySecretId: null,
      telegramChatId: "",
      rules: { ...defaultRules(), allowEmptyChecks: true, validationCommands: [] },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
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
      externalId: "card-1",
      title: "Ship billing",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      url: "",
      stage: "backlog",
      priority: 3,
      estimateHours: null,
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
    const synced = await syncConnectedBoards(store, masterKey, async (input) => {
      const url = String(input);
      if (url.includes("/lists")) return new Response(JSON.stringify([{ id: "list-doing", name: "Doing" }]));
      if (url.includes("/cards")) return new Response(JSON.stringify([{ id: "card-1", name: "Ship billing", desc: "", idList: "list-doing", url: "", labels: [], due: null }]));
      return new Response("{}", { status: 404 });
    });
    expect(synced).toBe(1);
    expect((await store.listTasks(agent.id)).find((task) => task.id === taskId)?.stage).toBe("doing");
  });
});
