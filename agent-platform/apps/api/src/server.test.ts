import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encryptSecret, hashPassword } from "@agent-platform/core";
import type { PlatformEnv } from "@agent-platform/core";
import { MemoryStore } from "@agent-platform/db";
import { memoryPairingStore } from "@agent-platform/integrations";
import { newId, nowIso } from "@agent-platform/shared";
import { buildServer } from "./server.js";

function env(dir: string): PlatformEnv {
  return {
    DATABASE_URL: "postgres://localhost/unused",
    REDIS_URL: "redis://localhost/0",
    APP_MASTER_KEY: "0123456789abcdef0123456789abcdef",
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "change-me-now",
    SESSION_SECRET: "session-secret-value",
    COOKIE_SECURE: "false",
    WORKSPACES_DIR: dir,
    API_PORT: 4000,
    WORKER_PORT: 4001,
    WORKER_CONCURRENCY: 2,
    MAX_RUNNING_AGENTS: 4,
    TICK_INTERVAL_MS: 15000,
    DOCKER_RUNTIME: "false",
    AGENT_RUNTIME_IMAGE: "agent-platform-runtime:local",
    AGENT_DOCKER_NETWORK: "agent-platform-agents",
    AGENT_CONTAINER_MEMORY: "1g",
    AGENT_CONTAINER_CPUS: "1",
    OLLAMA_BASE_URL: "",
    OPENAI_API_KEY: "",
    CURSOR_API_KEY: "",
    CODEX_API_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    APP_PUBLIC_URL: "",
  };
}

describe("api", () => {
  it("authenticates an admin and keeps approval and secret rules", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const queued: string[] = [];
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue(id) { queued.push(id); }, async ping() { return true; } },
      pairing: memoryPairingStore(),
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Billing", repositoryName: "acme/billing", executorKind: "fake", repositoryToken: "ghp_test_repository_token" },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    const workflow = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/workflow`, headers: { cookie } });
    const columns = workflow.json().columns;
    const raised = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/workflow`,
      headers: { cookie },
      payload: { columns, selection: { priorityLabels: [], blockedLabels: ["blocked"], maxTasksPerDay: 30 } },
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().selection.maxTasksPerDay).toBe(30);
    const unlimited = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/workflow`,
      headers: { cookie },
      payload: { columns, selection: { priorityLabels: [], blockedLabels: ["blocked"], maxTasksPerDay: null } },
    });
    expect(unlimited.statusCode).toBe(200);
    expect(unlimited.json().selection.maxTasksPerDay).toBe(0);
    const tooHigh = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/workflow`,
      headers: { cookie },
      payload: { columns, selection: { priorityLabels: [], blockedLabels: ["blocked"], maxTasksPerDay: 1001 } },
    });
    expect(tooHigh.statusCode).toBe(400);
    const skippedPlanning = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/workflow`,
      headers: { cookie },
      payload: { columns: { ...columns, planning: "" }, selection: { priorityLabels: [], blockedLabels: ["blocked"], maxTasksPerDay: 0 } },
    });
    expect(skippedPlanning.statusCode).toBe(200);
    expect(skippedPlanning.json().columns.planning).toBe("");
    expect(agent.name).toBe("Billing Agent");
    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tasks`,
      headers: { cookie },
      payload: { title: "Add health check" },
    });
    const task = taskResponse.json();
    const tooSoon = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve`, headers: { cookie }, payload: {} });
    expect(tooSoon.statusCode).toBe(409);
    task.stage = "review";
    task.checksPassed = true;
    await store.saveTask(task);
    const approved = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve`, headers: { cookie }, payload: { comment: "looks good" } });
    expect(approved.json().stage).toBe("done");
    const provider = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { cookie },
      payload: { name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", costClass: "hosted_free", apiKey: "sk-test-secret-value" },
    });
    expect(provider.statusCode).toBe(400);
    const localPaid = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { cookie },
      payload: { name: "Ollama", type: "ollama", baseUrl: "http://ollama:11434/v1", costClass: "local", apiKey: "local-token-value" },
    });
    expect(localPaid.statusCode).toBe(201);
    expect(JSON.stringify(localPaid.json())).not.toContain("local-token-value");
    expect(localPaid.json().credential.hint).toContain("••••");
    expect(localPaid.json().costClass).toBe("local");
    const started = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/start`, headers: { cookie } });
    expect(started.json().status).toBe("running");
    const emptyBody = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tick`,
      headers: { cookie, "content-type": "application/json" },
      payload: "",
    });
    expect(emptyBody.statusCode).toBe(200);
    expect(emptyBody.json()).toEqual({ queued: true });
    expect(queued).toContain(agent.id);
    await app.close();
  });

  it("opens a telegram pairing session and sends a test alert without echoing the bot token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-pair-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const pairing = memoryPairingStore();
    const calls: string[] = [];
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue() {}, async ping() { return true; } },
      pairing,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url.includes("getMe") ? "getMe" : url.includes("sendMessage") ? "sendMessage" : "other");
        if (url.includes("getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "AgentPlatformBot" } }));
        return new Response("{}", { status: 200 });
      },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const missing = await app.inject({ method: "POST", url: "/api/telegram/pair", headers: { cookie } });
    expect(missing.statusCode).toBe(400);
    await app.inject({
      method: "PUT",
      url: "/api/telegram",
      headers: { cookie },
      payload: { enabled: false, chatId: "", minSeverity: "warning", digestMinutes: 60, botToken: "123456:telegram-secret" },
    });
    const opened = await app.inject({ method: "POST", url: "/api/telegram/pair", headers: { cookie } });
    expect(opened.statusCode).toBe(200);
    const body = opened.json();
    expect(body.url).toBe(`https://t.me/AgentPlatformBot?start=pair_${body.token}`);
    expect(body.svg).toContain("<svg");
    expect(JSON.stringify(body)).not.toContain("telegram-secret");
    const pending = await app.inject({ method: "GET", url: `/api/telegram/pair/${body.token}`, headers: { cookie } });
    expect(pending.json().status).toBe("pending");
    await pairing.complete(body.token, "4242");
    const config = await store.getTelegramConfig();
    if (config) {
      config.chatId = "4242";
      config.enabled = true;
      await store.saveTelegramConfig(config);
    }
    const paired = await app.inject({ method: "GET", url: `/api/telegram/pair/${body.token}`, headers: { cookie } });
    expect(paired.json()).toMatchObject({ status: "paired", chatId: "4242", enabled: true });
    const test = await app.inject({ method: "POST", url: "/api/telegram/test", headers: { cookie } });
    expect(test.json()).toEqual({ sent: true });
    expect(calls).toEqual(["getMe", "sendMessage"]);
    await app.close();
  });

  it("rejects a duplicate model and shifts a backlog ticket from chat", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-chat-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const queued: string[] = [];
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue(id) { queued.push(id); }, async ping() { return true; } },
      pairing: memoryPairingStore(),
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const provider = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { cookie },
      payload: { name: "Ollama", type: "ollama", baseUrl: "http://ollama:11434/v1", costClass: "local" },
    });
    const providerId = provider.json().id as string;
    expect(provider.statusCode).toBe(201);
    const updated = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { cookie },
      payload: { name: "Ollama local", type: "ollama", baseUrl: "http://host.docker.internal:11434/v1", costClass: "local", apiKey: "sk-local-key-1234567890" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().updated).toBe(true);
    expect(updated.json().id).toBe(providerId);
    expect(updated.json().baseUrl).toBe("http://host.docker.internal:11434/v1");
    expect(JSON.stringify(updated.json())).not.toContain("sk-local-key-1234567890");
    const listed = await app.inject({ method: "GET", url: "/api/providers", headers: { cookie } });
    expect(listed.json().filter((item: { type: string }) => item.type === "ollama")).toHaveLength(1);
    const first = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: { cookie },
      payload: { providerId, modelId: "qwen2.5-coder", displayName: "Qwen", costClass: "local" },
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: { cookie },
      payload: { providerId, modelId: "Qwen2.5-Coder", displayName: "Qwen again", costClass: "local" },
    });
    expect(duplicate.statusCode).toBe(409);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Billing", repositoryName: "acme/billing", repositoryToken: "ghp_test_repository_token" },
    });
    const agent = created.json();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/start`, headers: { cookie } });
    const task = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tasks`,
      headers: { cookie },
      payload: { title: "Add invoice export" },
    });
    const externalId = task.json().externalId as string;
    const columns = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/board-columns`, headers: { cookie } });
    expect(columns.json()).toEqual({ columns: [], connected: false });
    const status = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "What are you working on?" },
    });
    expect(status.json().reply).toContain("Backlog");
    const doing = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "what are you doing" },
    });
    expect(doing.json().reply).toContain("acme/billing");
    const outside = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "tell me a joke" },
    });
    expect(outside.json().reply).toContain("only talk about this project");
    const backlog = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "list the backlog" },
    });
    expect(backlog.json().reply).toContain("Add invoice export");
    const restarted = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "restart" },
    });
    expect(restarted.json().reply).toContain("restarted");
    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "push" },
    });
    expect(started.json().reply).toContain("pushed to work");
    const ticked = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "tick" },
    });
    expect(ticked.json().reply).toContain("queued for a tick");
    const synced = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "sync" },
    });
    expect(synced.json().reply).toContain("no board to sync");
    const shifted = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: `Shift to ticket #${externalId}` },
    });
    expect(shifted.json().reply).toContain("Doing");
    expect(shifted.json().tasks[0].stage).toBe("doing");
    expect(queued).toContain(agent.id);
    const skill = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/skills`,
      headers: { cookie },
      payload: { name: "Release notes", description: "Update the changelog for user-facing changes." },
    });
    expect(skill.statusCode).toBe(201);
    expect(skill.json().skill.id).toBe("custom-release-notes");
    expect(skill.json().rules.skills["custom-release-notes"]).toBe(true);
    const again = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/skills`,
      headers: { cookie },
      payload: { name: "Release notes" },
    });
    expect(again.statusCode).toBe(409);
    const removedSkill = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/skills/custom-release-notes`,
      headers: { cookie },
    });
    expect(removedSkill.statusCode).toBe(200);
    expect(removedSkill.json().rules.customSkills).toEqual([]);
    expect(removedSkill.json().rules.skills["custom-release-notes"]).toBeUndefined();
    const builtin = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/skills/security-audit`,
      headers: { cookie },
    });
    expect(builtin.statusCode).toBe(404);
    const memory = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/memories`,
      headers: { cookie },
      payload: { kind: "decision", title: "Billing conventions", body: "Keep invoice totals in cents." },
    });
    expect(memory.statusCode).toBe(201);
    const removedMemory = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/memories/${memory.json().id}`,
      headers: { cookie },
    });
    expect(removedMemory.statusCode).toBe(200);
    const remainingMemories = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/memories`, headers: { cookie } });
    expect(remainingMemories.json()).toEqual([]);
    const linked = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Stack", repositoryName: "acme/web", linkedRepositories: ["acme/api", "acme/web"], repositoryToken: "ghp_test_repository_token" },
    });
    expect(linked.statusCode).toBe(400);
    const createdLinked = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Stack", repositoryName: "acme/web", linkedRepositories: ["acme/api"], repositoryToken: "ghp_test_repository_token" },
    });
    expect(createdLinked.statusCode).toBe(201);
    expect(createdLinked.json().linkedRepositories).toEqual(["acme/api"]);
    const removed = await app.inject({ method: "DELETE", url: `/api/providers/${providerId}`, headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    const models = await app.inject({ method: "GET", url: "/api/models", headers: { cookie } });
    expect(models.json().some((item: { providerId: string }) => item.providerId === providerId)).toBe(false);
    const providers = await app.inject({ method: "GET", url: "/api/providers", headers: { cookie } });
    expect(providers.json().some((item: { id: string }) => item.id === providerId)).toBe(false);
    await app.close();
  });

  it("loads mapped board tickets from List tickets and explains a missing Trello key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-board-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/lists")) return Response.json([{ id: "list-1", name: "To Do" }]);
      if (url.includes("/cards")) return Response.json([{ id: "card-7", name: "Ship billing", desc: "", idList: "list-1", url: "https://trello.test/c/7", labels: [], due: null }]);
      return new Response("missing", { status: 404 });
    };
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue() { return undefined; }, async ping() { return true; } },
      pairing: memoryPairingStore(),
      fetchImpl,
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "BitVox", repositoryName: "acme/bitvox", provider: "trello", boardId: "board", credential: JSON.stringify({ key: "key", token: "token" }), repositoryToken: "ghp_test_repository_token" },
    });
    const agent = created.json();
    const listed = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/chat`,
      headers: { cookie },
      payload: { message: "List tickets" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().reply).toContain("Ship billing");
    expect(listed.json().tasks).toHaveLength(1);
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Token only", repositoryName: "acme/token-only", provider: "trello", boardId: "board", credential: "raw-token", repositoryToken: "ghp_test_repository_token" },
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/agents/${missingKey.json().id}/chat`,
      headers: { cookie },
      payload: { message: "List tickets" },
    });
    expect(blocked.json().reply).toContain("API key");
    expect(blocked.json().reply).not.toBe("No tickets.");
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/agents/${missingKey.json().id}`,
      headers: { cookie },
      payload: { boardKey: "key", boardToken: "token" },
    });
    expect(patched.statusCode).toBe(200);
    const loaded = await app.inject({
      method: "POST",
      url: `/api/agents/${missingKey.json().id}/chat`,
      headers: { cookie },
      payload: { message: "List tickets" },
    });
    expect(loaded.json().reply).toContain("Ship billing");
    await app.close();
  });

  it("merges an approved pull request into develop and alerts Telegram", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "github-test-token";
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-merge-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const sealed = encryptSecret("bot-token", env(dir).APP_MASTER_KEY);
    const secretId = newId();
    await store.putSecret({
      id: secretId,
      name: "telegram",
      ...sealed,
      hint: "••••",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await store.saveTelegramConfig({
      enabled: true,
      botSecretId: secretId,
      chatId: "99",
      minSeverity: "info",
      digestMinutes: 60,
      lastDigestAt: null,
    });
    const calls: string[] = [];
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue() {}, async ping() { return true; } },
      pairing: memoryPairingStore(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/pulls/4") && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ merged: false, base: { ref: "main" } }));
        }
        if (url.endsWith("/pulls/4") && init?.method === "PATCH") return new Response("{}", { status: 200 });
        if (url.endsWith("/merge")) return new Response(JSON.stringify({ merged: true }), { status: 200 });
        if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response("{}", { status: 404 });
      },
    });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { cookie },
        payload: { boardName: "Billing", repositoryName: "acme/billing", executorKind: "fake", repositoryToken: "ghp_test_repository_token" },
      });
      const agent = created.json();
      const taskResponse = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/tasks`,
        headers: { cookie },
        payload: { title: "Add health check" },
      });
      const task = taskResponse.json();
      task.stage = "review";
      task.checksPassed = true;
      task.branchName = "feature/health";
      task.prUrl = "https://github.com/acme/billing/pull/4";
      await store.saveTask(task);
      const approved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/approve`,
        headers: { cookie },
        payload: { comment: "looks good" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().stage).toBe("done");
      expect(approved.json().mergedInto).toBe("develop");
      expect(calls.some((call) => call.startsWith("PUT") && call.includes("/merge"))).toBe(true);
      expect(calls.some((call) => call.includes("api.telegram.org"))).toBe(true);
      expect(JSON.stringify(approved.json())).not.toContain("github-test-token");
      const notes = await store.listNotifications();
      expect(notes.some((note) => note.title === "Pull request merged" && note.delivered)).toBe(true);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it("refreshes a Trello board and applies a card move webhook", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-board-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue() {}, async ping() { return true; } },
      pairing: memoryPairingStore(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/lists")) return new Response(JSON.stringify([{ id: "list-todo", name: "To Do" }]));
        if (url.includes("/cards")) {
          return new Response(JSON.stringify([{ id: "card-1", name: "Ship billing", desc: "details", idList: "list-todo", url: "https://trello.test/c/1", labels: [], due: null }]));
        }
        return new Response("{}", { status: 404 });
      },
    });
    const probe = await app.inject({ method: "HEAD", url: "/api/webhooks/trello" });
    expect(probe.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Board Agent", provider: "trello", boardId: "board-1", boardName: "BitVox", repositoryName: "acme/bitvox", boardKey: "trello-key", boardToken: "trello-token", executorKind: "fake", repositoryToken: "ghp_test_repository_token" },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tasks`,
      headers: { cookie },
      payload: { title: "Ship billing" },
    });
    const task = taskResponse.json();
    task.externalId = "card-1";
    await store.saveTask(task);
    const synced = await app.inject({ method: "POST", url: `/api/boards/${agent.id}/sync`, headers: { cookie } });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().tasks.find((item: { externalId: string }) => item.externalId === "card-1").stage).toBe("todo");
    expect(JSON.stringify(synced.json())).not.toContain("trello-token");
    const moved = await app.inject({
      method: "POST",
      url: "/api/webhooks/trello",
      payload: {
        action: {
          type: "updateCard",
          display: { translationKey: "action_moved_card_lower" },
          data: {
            card: { id: "card-1", name: "Ship billing" },
            board: { id: "board-1" },
            listAfter: { id: "list-doing", name: "Doing" },
            old: { idList: "list-todo" },
          },
        },
      },
    });
    expect(moved.statusCode).toBe(200);
    expect((await store.listTasks(agent.id)).find((item) => item.externalId === "card-1")?.stage).toBe("doing");
    await app.close();
  });

  it("returns live activity for a doing ticket", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-api-activity-"));
    const store = new MemoryStore();
    await store.createUser({
      id: newId(),
      email: "admin@example.com",
      passwordHash: await hashPassword("change-me-now"),
      createdAt: nowIso(),
    });
    const app = buildServer({
      store,
      env: env(dir),
      queue: { async enqueue() {}, async ping() { return true; } },
      pairing: memoryPairingStore(),
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "change-me-now" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { boardName: "Watch", repositoryName: "acme/watch", executorKind: "fake", repositoryToken: "ghp_test_repository_token" },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tasks`,
      headers: { cookie },
      payload: { title: "Watch me work" },
    });
    const task = taskResponse.json();
    task.stage = "doing";
    await store.saveTask(task);
    const runId = newId();
    await store.createRun({
      id: runId,
      taskId: task.id,
      agentId: agent.id,
      executorId: "fake",
      status: "running",
      activity: "coding",
      modelId: "fake",
      costClass: "none",
      summary: "",
      error: "",
      tokensIn: 0,
      tokensOut: 0,
      startedAt: nowIso(),
      finishedAt: null,
    });
    await store.addEvent({
      id: newId(),
      agentId: agent.id,
      taskId: task.id,
      kind: "executor_thinking",
      message: "Planning the auth change",
      metadata: { progressKind: "thinking", runId },
      createdAt: nowIso(),
    });
    await store.saveCheckpoint({
      id: newId(),
      taskRunId: runId,
      agentId: agent.id,
      step: 1,
      note: "Wrote src/auth.ts",
      ownedFiles: ["src/auth.ts"],
      createdAt: nowIso(),
    });
    const activity = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/activity`, headers: { cookie } });
    expect(activity.statusCode).toBe(200);
    const body = activity.json();
    expect(body.task.title).toBe("Watch me work");
    expect(body.activeRun?.status).toBe("running");
    expect(body.events[0].message).toBe("Planning the auth change");
    expect(body.checkpoints[0].note).toBe("Wrote src/auth.ts");
    await app.close();
  });
});
