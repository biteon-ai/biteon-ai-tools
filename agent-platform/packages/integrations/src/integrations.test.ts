import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRules, newId, nowIso, type Agent } from "@agent-platform/shared";
import { ProcessRuntime } from "@agent-platform/core";
import { createBoardClient, listBoardColumns, parseCredentials } from "./board-factory.js";
import { parseProjectItems } from "./github.js";
import { openLinkedChanges, mergeApprovedChanges } from "./changes.js";
import { WorkspaceGit } from "./git.js";
import { createPairingStore, memoryPairingStore, parsePairingStart, telegramDeepLink, type PairingCache } from "./pairing.js";
import { listTrelloCards, readTrelloCardMove, registerTrelloWebhook, trelloListId } from "./trello.js";
import { telegramBotProfile } from "./telegram.js";

describe("integrations", () => {
  it("parses Trello cards and GitHub project status without leaking tokens", async () => {
    const seen: string[] = [];
    const cards = await listTrelloCards({ key: "key", token: "super-secret-token" }, "board", async (input) => {
      seen.push(String(input));
      const url = String(input);
      if (url.includes("/lists")) {
        return new Response(JSON.stringify([{ id: "list-1", name: "To Do" }]));
      }
      return new Response(JSON.stringify([
        { id: "card-low", name: "Later", desc: "", idList: "list-1", url: "", labels: [], due: null, pos: 200 },
        { id: "card-1", name: "Ship it", desc: "details", idList: "list-1", url: "https://trello.test/c/1", labels: [], due: null, pos: 100 },
      ]));
    });
    expect(cards.map((card) => card.externalId)).toEqual(["card-1", "card-low"]);
    const listId = await trelloListId({ key: "key", token: "token" }, "board", "To Do", async () => new Response(JSON.stringify([{ id: "list-todo", name: "ToDO" }])));
    expect(listId).toBe("list-todo");
    expect(cards[0]?.columnName).toBe("To Do");
    expect(cards[0]?.position).toBe(100);
    expect(seen.every((url) => !url.includes("logged"))).toBe(true);
    const parsed = parseProjectItems([{
      id: "ITEM_1",
      content: { title: "Issue", body: "body", url: "https://github.test/1" },
      fieldValues: { nodes: [{ name: "Doing", field: { name: "Status" } }] },
    }]);
    expect(parsed[0]?.columnName).toBe("Doing");
    expect(parseCredentials('{"token":"abc"}', "github_projects").token).toBe("abc");
    expect(parseCredentials("raw-trello-token", "trello")).toEqual({ key: "", token: "raw-trello-token" });
    expect(parseCredentials('{"key":"k","token":"t"}', "trello")).toEqual({ key: "k", token: "t" });
    const columns = await listBoardColumns({
      provider: "trello",
      boardId: "board",
      credentials: { key: "key", token: "token" },
      fetchImpl: async () => new Response(JSON.stringify([{ id: "1", name: "Backlog" }, { id: "2", name: "Doing" }])),
    });
    expect(columns).toEqual(["Backlog", "Doing"]);
  });

  it("moves a GitHub project card through the status field", async () => {
    const calls: string[] = [];
    const board = createBoardClient({
      provider: "github_projects",
      boardId: "PVT_1",
      credentials: { key: "", token: "github-token" },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: { optionId?: string } };
        calls.push(body.query);
        if (body.query.includes("updateProjectV2ItemFieldValue")) {
          expect(body.variables.optionId).toBe("opt-review");
          return new Response(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } } }));
        }
        return new Response(JSON.stringify({
          data: {
            node: {
              fields: { nodes: [{ id: "field-1", name: "Status", options: [{ id: "opt-review", name: "Review" }] }] },
              items: { nodes: [] },
            },
          },
        }));
      },
    });
    await board?.moveCard("ITEM_1", "Review");
    expect(calls.some((query) => query.includes("updateProjectV2ItemFieldValue"))).toBe(true);
  });

  it("commits on a feature branch and refuses to rewrite history", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-git-"));
    const runtime = new ProcessRuntime();
    const agent: Agent = {
      id: "agent-git",
      name: "Repo Agent",
      description: "",
      status: "running",
      repositoryUrl: "",
      repositoryName: "",
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
      rules: defaultRules(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await runtime.ensure({ id: agent.id, workspacePath: workspace });
    const git = new WorkspaceGit(runtime);
    const prepared = await git.prepare(agent, {
      id: newId(),
      agentId: agent.id,
      externalId: "card-9",
      title: "Add note",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      url: "",
      stage: "doing",
      priority: 1,
      estimateHours: 1,
      dependsOn: [],
      dueAt: null,
      plan: "",
      branchName: "agent/card-9-add-note",
      prUrl: "",
      blockedReason: "",
      exceptionNote: "",
      checksPassed: false,
      labels: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }, []);
    expect(prepared.dirtyForeign).toBe(false);
    await writeFile(path.join(workspace, "NOTE.md"), "hello\n", "utf8");
    await git.commitAndPush(agent, { ...prepared, id: "t", agentId: agent.id, externalId: "card-9", title: "Add note", description: "", acceptanceCriteria: "", comments: [], url: "", stage: "doing", priority: 1, estimateHours: 1, dependsOn: [], dueAt: null, plan: "", branchName: prepared.branch, prUrl: "", blockedReason: "", exceptionNote: "", checksPassed: false, labels: [], createdAt: nowIso(), updatedAt: nowIso() }, ["NOTE.md"], "Add note (task card-9)");
    const head = await runtime.exec(agent.id, "git", ["log", "-1", "--pretty=%s"], { hostCwd: workspace, timeoutMs: 10000 });
    expect(head.stdout.trim()).toBe("Add note (task card-9)");
    await expect(runtime.exec(agent.id, "git", ["push", "--force"], { hostCwd: workspace, timeoutMs: 10000 })).rejects.toThrow(/destructive/);
    await expect(runtime.exec(agent.id, "git", ["merge", "develop"], { hostCwd: workspace, timeoutMs: 10000 })).rejects.toThrow(/human approval/);
  });

  it("reports a conflict dry-run before review when the task branch diverges from the base", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-conflict-"));
    const runtime = new ProcessRuntime();
    const agentId = newId();
    await runtime.ensure({ id: agentId, workspacePath: workspace });
    const git = (...args: string[]) => runtime.exec(agentId, "git", args, { hostCwd: workspace, timeoutMs: 10000 });
    await git("init", "-b", "main");
    await git("config", "user.email", "agent@localhost");
    await git("config", "user.name", "Agent");
    await writeFile(path.join(workspace, "FILE.md"), "base\n", "utf8");
    await git("add", "FILE.md");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "agent/card-9");
    await writeFile(path.join(workspace, "FILE.md"), "feature\n", "utf8");
    await git("add", "FILE.md");
    await git("commit", "-m", "feature");
    await git("checkout", "main");
    await writeFile(path.join(workspace, "FILE.md"), "other\n", "utf8");
    await git("add", "FILE.md");
    await git("commit", "-m", "other");
    await git("checkout", "agent/card-9");
    const agent: Agent = {
      id: agentId,
      name: "Repo Agent",
      description: "",
      status: "running",
      repositoryUrl: "",
      repositoryName: "acme/repo",
      linkedRepositories: [],
      defaultBranch: "main",
      provider: "none",
      boardId: "",
      boardName: "",
      workspacePath: workspace,
      executorKind: "fake",
      dailyCapacityHours: 8,
      allowOverCapacity: false,
      credentialSecretId: null,
      telegramChatId: "",
      rules: defaultRules(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const conflict = await new WorkspaceGit(runtime).conflictCheck(agent, "main");
    expect(conflict.clean).toBe(false);
    expect(conflict.detail).toMatch(/exited 1/);
  });

  it("commits the same ticket in the primary and linked repositories", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-multi-"));
    const runtime = new ProcessRuntime();
    const agent: Agent = {
      id: "agent-multi",
      name: "Stack Agent",
      description: "",
      status: "running",
      repositoryUrl: "",
      repositoryName: "acme/web",
      linkedRepositories: ["acme/api"],
      defaultBranch: "main",
      provider: "none",
      boardId: "",
      boardName: "Stack",
      workspacePath: workspace,
      executorKind: "fake",
      dailyCapacityHours: 8,
      allowOverCapacity: false,
      credentialSecretId: null,
      telegramChatId: "",
      rules: defaultRules(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await runtime.ensure(agent);
    for (const directory of ["repo-primary", "repo-secondary"]) {
      const cwd = path.join(workspace, directory);
      await runtime.exec(agent.id, "git", ["init", "-b", "main"], { hostCwd: cwd, timeoutMs: 10000 });
      await runtime.exec(agent.id, "git", ["config", "user.email", "test@localhost"], { hostCwd: cwd, timeoutMs: 10000 });
      await runtime.exec(agent.id, "git", ["config", "user.name", "Test"], { hostCwd: cwd, timeoutMs: 10000 });
      await writeFile(path.join(cwd, "README.md"), "base\n", "utf8");
      await runtime.exec(agent.id, "git", ["add", "README.md"], { hostCwd: cwd, timeoutMs: 10000 });
      await runtime.exec(agent.id, "git", ["commit", "-m", "base"], { hostCwd: cwd, timeoutMs: 10000 });
    }
    const git = new WorkspaceGit(runtime);
    const task = {
      id: "task-1",
      agentId: agent.id,
      externalId: "card-42",
      title: "Add export",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      url: "https://trello.example/card-42",
      stage: "doing" as const,
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
    };
    const prepared = await git.prepare(agent, task, []);
    expect(prepared.branch).toBe("agent/card-42");
    await writeFile(path.join(workspace, "repo-primary", "PAGE.md"), "page\n", "utf8");
    await writeFile(path.join(workspace, "repo-secondary", "ROUTE.md"), "route\n", "utf8");
    await git.commitAndPush(agent, { ...task, branchName: prepared.branch }, ["repo-primary/PAGE.md", "repo-secondary/ROUTE.md"], "Add export (task card-42)");
    for (const directory of ["repo-primary", "repo-secondary"]) {
      const head = await runtime.exec(agent.id, "git", ["log", "-1", "--pretty=%s"], { hostCwd: path.join(workspace, directory), timeoutMs: 10000 });
      expect(head.stdout.trim()).toBe("Add export (task card-42)");
    }
  });

  it("reads a Trello card move and registers a webhook without returning the token", async () => {
    const move = readTrelloCardMove({
      action: {
        type: "updateCard",
        display: { translationKey: "action_moved_card_lower" },
        data: {
          card: { id: "card-1", name: "Ship it" },
          board: { id: "board-1" },
          listAfter: { id: "list-doing", name: "Doing" },
          old: { idList: "list-backlog" },
        },
      },
    });
    expect(move).toMatchObject({ boardId: "board-1", cardId: "card-1", listId: "list-doing", listName: "Doing" });
    expect(readTrelloCardMove({ action: { type: "commentCard", data: { card: { id: "card-1" }, board: { id: "board-1" } } } })).toBeNull();
    let seen = "";
    const registered = await registerTrelloWebhook({ key: "key", token: "super-secret-token" }, "board-1", "https://agents.example.com/api/webhooks/trello", async (input, init) => {
      seen = `${String(input)} ${typeof init?.body === "string" ? init.body : ""}`;
      return new Response(JSON.stringify({ id: "hook-1" }), { status: 200 });
    });
    expect(registered).toEqual({ ok: true, id: "hook-1" });
    expect(seen).toContain("https://agents.example.com/api/webhooks/trello");
    expect(JSON.stringify(registered)).not.toContain("super-secret-token");
  });

  it("opens cross-referenced GitHub and GitLab requests for one ticket", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/web/pull/7", number: 7 }));
      }
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") return new Response("{}", { status: 200 });
      if (url.includes("/merge_requests") && init?.method === "POST") {
        return new Response(JSON.stringify({ web_url: "https://gitlab.com/acme/api/-/merge_requests/3", iid: 3 }));
      }
      if (url.includes("/merge_requests/3") && init?.method === "PUT") return new Response("{}", { status: 200 });
      return new Response("[]", { status: 404 });
    };
    const opened = await openLinkedChanges({
      token: "secret-token",
      targets: [
        { name: "acme/web", host: "github", apiOrigin: "https://api.github.com" },
        { name: "acme/api", host: "gitlab", apiOrigin: "https://gitlab.com" },
      ],
      head: "agent/card-42",
      base: "main",
      title: "Add export",
      ticket: "card-42",
      ticketUrl: "https://trello.example/card-42",
      fetchImpl,
    });
    expect(opened.map((item) => item.url)).toEqual([
      "https://github.com/acme/web/pull/7",
      "https://gitlab.com/acme/api/-/merge_requests/3",
    ]);
    expect(calls.some((call) => call.startsWith("PATCH"))).toBe(true);
    expect(calls.some((call) => call.startsWith("PUT"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("secret-token");
  });

  it("merges an approved pull request into develop", async () => {
    const calls: { method: string; url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/pulls/7") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ merged: false, base: { ref: "main" } }));
      }
      if (url.endsWith("/pulls/7") && init?.method === "PATCH") return new Response("{}", { status: 200 });
      if (url.endsWith("/pulls/7/merge") && init?.method === "PUT") return new Response(JSON.stringify({ merged: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const merged = await mergeApprovedChanges({
      token: "secret-token",
      urls: ["https://github.com/acme/web/pull/7"],
      fetchImpl,
    });
    expect(merged.base).toBe("develop");
    expect(calls.find((call) => call.method === "PATCH")?.body).toContain("develop");
    expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/merge"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("secret-token");
  });
});

describe("telegram pairing", () => {
  it("reads a start payload and completes a session once", async () => {
    expect(parsePairingStart("/start pair_0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(parsePairingStart("/start@AgentPlatformBot pair_0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(parsePairingStart("/start hello")).toBeNull();
    const token = "0123456789abcdef0123456789abcdef";
    const store = memoryPairingStore();
    const session = {
      token,
      status: "pending" as const,
      chatId: "",
      botUsername: "AgentPlatformBot",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.save(session);
    expect(telegramDeepLink("AgentPlatformBot", token)).toBe(`https://t.me/AgentPlatformBot?start=pair_${token}`);
    expect((await store.complete(token, "4242"))?.status).toBe("paired");
    expect((await store.get(token))?.chatId).toBe("4242");
    expect(await store.complete("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1")).toBeNull();
  });

  it("keeps the remaining lifetime when a cached session is completed", async () => {
    const rows = new Map<string, { value: string; expires: number }>();
    const cache: PairingCache = {
      async get(key) {
        const row = rows.get(key);
        if (!row || row.expires <= Date.now()) return null;
        return row.value;
      },
      async set(key, value, _mode, seconds) {
        rows.set(key, { value, expires: Date.now() + seconds * 1000 });
      },
      async ttl(key) {
        const row = rows.get(key);
        if (!row) return -2;
        return Math.ceil((row.expires - Date.now()) / 1000);
      },
    };
    const store = createPairingStore(cache);
    const token = "fedcba9876543210fedcba9876543210";
    await store.save({
      token,
      status: "pending",
      chatId: "",
      botUsername: "AgentPlatformBot",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const paired = await store.complete(token, "99");
    expect(paired?.chatId).toBe("99");
    expect(await cache.ttl(`telegram:pair:${token}`)).toBeGreaterThan(0);
  });

  it("reads the bot username without returning the token", async () => {
    const profile = await telegramBotProfile("123:secret", async (input) => {
      expect(String(input)).toContain("/getMe");
      return new Response(JSON.stringify({ ok: true, result: { username: "AgentPlatformBot" } }));
    });
    expect(profile.username).toBe("AgentPlatformBot");
    await expect(telegramBotProfile("123:secret", async () => new Response("{}", { status: 401 }))).rejects.toThrow(/lookup failed/);
  });
});
