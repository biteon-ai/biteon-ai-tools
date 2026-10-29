import { newId, nowIso, defaultRules, DEFAULT_COLUMNS, DEFAULT_SELECTION_RULES, emptyScheduler } from "@agent-platform/shared";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";
import type { PlatformStore } from "./store.js";

export async function assertStoreRoundTrip(store: PlatformStore): Promise<void> {
  const user = await store.createUser({
    id: newId(),
    email: `admin-${newId()}@example.com`,
    passwordHash: "hash",
    createdAt: nowIso(),
  });
  expect(await store.findUserByEmail(user.email)).toMatchObject({ id: user.id });
  const agentId = newId();
  const agent = {
    id: agentId,
    name: "Billing Agent",
    description: "books",
    status: "created" as const,
    repositoryUrl: "https://example.test/billing.git",
    repositoryName: "acme/billing",
    linkedRepositories: [],
    defaultBranch: "main",
    provider: "none" as const,
    boardId: "",
    boardName: "Billing",
    workspacePath: `/tmp/${agentId}`,
    executorKind: "fake" as const,
    dailyCapacityHours: 8,
    allowOverCapacity: false,
    credentialSecretId: null,
    repositorySecretId: null,
    telegramChatId: "",
    rules: defaultRules(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store.insertAgent(agent);
  await store.saveWorkflow({
    id: newId(),
    agentId,
    name: "Default",
    columns: DEFAULT_COLUMNS,
    selection: DEFAULT_SELECTION_RULES,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  await store.saveScheduler(emptyScheduler(agentId));
  const task = {
    id: newId(),
    agentId,
    externalId: "card-1",
    title: "Health",
    description: "check",
    acceptanceCriteria: "200",
    comments: ["note"],
    url: "",
    stage: "backlog" as const,
    priority: 1,
    estimateHours: 2,
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
  };
  await store.saveTask(task);
  expect((await store.listTasks(agentId))[0]?.title).toBe("Health");
  const secret = {
    id: newId(),
    name: "openai",
    ciphertext: "cipher",
    iv: "iv",
    authTag: "tag",
    hint: "••••abcd",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store.putSecret(secret);
  expect((await store.getSecret(secret.id))?.ciphertext).toBe("cipher");
  await store.deleteAgent(agentId);
  expect(await store.getAgent(agentId)).toBeNull();
  expect(await store.listTasks(agentId)).toHaveLength(0);
  expect(await store.getSecret(secret.id)).not.toBeNull();
}

describe("memory store", () => {
  it("round-trips agents, tasks, and secrets", async () => {
    await assertStoreRoundTrip(new MemoryStore());
  });
});
