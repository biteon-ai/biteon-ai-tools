import { approveTask, columnForStage, decryptSecret, describeColumn, describeProblems, describeProgress, describeProject, describeTicket, findTickets, interpretProjectChat, mergeCards, parseTelegramCommand, PROJECT_SCOPE, rejectTask, shiftToTicket, ticketLabel, WorkflowError } from "@agent-platform/core";
import type { PlatformStore } from "@agent-platform/db";
import { createBoardClient, parseCredentials } from "@agent-platform/integrations";
import { newId, nowIso, type Agent, type Task } from "@agent-platform/shared";

export interface TelegramHooks {
  enqueue?: (agentId: string) => Promise<void>;
}

export async function handleTelegramCommand(store: PlatformStore, text: string, masterKey: string, hooks: TelegramHooks = {}): Promise<string> {
  const parsed = parseTelegramCommand(text);
  const agents = await store.listAgents();
  if (parsed) return slashCommand(store, parsed, agents, masterKey, hooks);
  return projectChat(store, text, agents, masterKey, hooks);
}

async function slashCommand(store: PlatformStore, parsed: { command: string; arg: string }, agents: Agent[], masterKey: string, hooks: TelegramHooks): Promise<string> {
  if (parsed.command === "/help" || parsed.command === "/commands" || parsed.command === "/agents") return commandList(agents);
  if (parsed.command === "/status" || parsed.command === "/backlog" || parsed.command === "/done" || parsed.command === "/problems") {
    return scopedReport(store, agents, parsed.arg, parsed.command);
  }
  if (parsed.command === "/howfar") return progressReport(store, agents, parsed.arg);
  if (parsed.command === "/start" || parsed.command === "/push" || parsed.command === "/restart" || parsed.command === "/pause" || parsed.command === "/resume" || parsed.command === "/stop" || parsed.command === "/tick" || parsed.command === "/sync") {
    const resolved = resolveOne(agents, parsed.arg, parsed.command.slice(1));
    if (typeof resolved === "string") return resolved;
    if (parsed.command === "/pause") return setStatus(store, resolved, "paused");
    if (parsed.command === "/resume") return setStatus(store, resolved, "running", hooks);
    if (parsed.command === "/stop") return setStatus(store, resolved, "stopped");
    if (parsed.command === "/tick") return tickAgent(resolved, hooks);
    if (parsed.command === "/sync") return syncBoard(store, resolved, masterKey);
    return runAgent(store, resolved, hooks, parsed.command === "/restart" ? "restarted" : parsed.command === "/push" ? "pushed" : "started");
  }
  if (parsed.command === "/approve" || parsed.command === "/reject") {
    const task = (await store.listTasks()).find((item) => item.id === parsed.arg || item.externalId === parsed.arg);
    if (!task) return "Task not found.";
    return decideTask(store, agents, task, parsed.command === "/approve" ? "approved" : "rejected", masterKey);
  }
  return commandList(agents);
}

async function projectChat(store: PlatformStore, text: string, agents: Agent[], masterKey: string, hooks: TelegramHooks): Promise<string> {
  if (agents.length === 0) return "No agents are configured yet.";
  const named = mentionedAgent(text, agents);
  const body = named ? text.replace(new RegExp(escapeRegExp(named.name), "ig"), " ").replace(/\s+/g, " ").trim() : text;
  const intent = interpretProjectChat(body || text);
  const targets = named ? [named] : agents;
  let reply = PROJECT_SCOPE;

  if (intent.kind === "help") {
    reply = commandList(agents);
  } else if (intent.kind === "status" || intent.kind === "about" || (intent.kind === "out_of_scope" && named && !body)) {
    const lines = [];
    for (const agent of targets) lines.push(describeProject(agent, await store.listTasks(agent.id), new Date()));
    reply = lines.join("\n\n");
  } else if (intent.kind === "progress") {
    reply = await progressReport(store, targets, intent.query);
  } else if (intent.kind === "list" || intent.kind === "backlog" || intent.kind === "done" || intent.kind === "problems") {
    const lines = [];
    for (const agent of targets) {
      const tasks = await store.listTasks(agent.id);
      if (intent.kind === "list") lines.push(`${agent.name}\n${tasks.length === 0 ? "No tickets." : `${describeColumn(tasks, "backlog")}\n${describeColumn(tasks, "doing")}\n${tasks.filter((task) => task.stage === "done").length} done. Say “what has been done” to list them.`}`);
      else lines.push(await reportFor(store, agent, intent.kind === "backlog" ? "/backlog" : intent.kind === "done" ? "/done" : "/problems"));
    }
    reply = lines.join("\n\n");
  } else if (intent.kind === "restart" || intent.kind === "start" || intent.kind === "push") {
    const verb = intent.kind === "restart" ? "restart" : intent.kind;
    const agent = named ?? (targets.length === 1 ? targets[0] : undefined);
    reply = agent ? await runAgent(store, agent, hooks, intent.kind === "restart" ? "restarted" : intent.kind === "push" ? "pushed" : "started") : askWhich(agents, verb);
  } else if (intent.kind === "pause" || intent.kind === "resume") {
    const agent = named ?? (targets.length === 1 ? targets[0] : undefined);
    reply = agent ? await setStatus(store, agent, intent.kind === "resume" ? "running" : "paused", hooks) : askWhich(agents, intent.kind);
  } else if (intent.kind === "stop") {
    const agent = named ?? (targets.length === 1 ? targets[0] : undefined);
    reply = agent ? await setStatus(store, agent, "stopped") : askWhich(agents, "stop");
  } else if (intent.kind === "tick") {
    const agent = named ?? (targets.length === 1 ? targets[0] : undefined);
    reply = agent ? await tickAgent(agent, hooks) : askWhich(agents, "tick");
  } else if (intent.kind === "sync") {
    const agent = named ?? (targets.length === 1 ? targets[0] : undefined);
    reply = agent ? await syncBoard(store, agent, masterKey) : askWhich(agents, "sync");
  } else if (intent.kind === "shift") {
    reply = await shiftAcross(store, targets, intent.ticket, masterKey, hooks);
  } else if (intent.kind === "ticket") {
    reply = await describeMatch(targets, store, intent.query, true);
  } else if (intent.kind === "approve" || intent.kind === "reject") {
    reply = await decideAcross(store, targets, intent.ticket, intent.kind === "approve" ? "approved" : "rejected", masterKey);
  } else {
    reply = await describeMatch(targets, store, body || text, false) || PROJECT_SCOPE;
  }

  const owner = named ?? (targets.length === 1 ? targets[0] : undefined);
  if (owner) {
    await store.addEvent({
      id: newId(),
      agentId: owner.id,
      taskId: null,
      kind: "chat",
      message: reply,
      metadata: { command: text, source: "telegram" },
      createdAt: nowIso(),
    });
  }
  return reply;
}

function mentionedAgent(text: string, agents: Agent[]): Agent | undefined {
  const lower = text.toLowerCase();
  return [...agents].sort((left, right) => labelOf(right).length - labelOf(left).length).find((agent) => labelsOf(agent).some((label) => label.length > 1 && lower.includes(label.toLowerCase())));
}

function labelsOf(agent: Agent): string[] {
  return [agent.name, agent.repositoryName, agent.boardName].filter((label) => label.length > 1);
}

function labelOf(agent: Agent): string {
  return `${agent.name} ${agent.repositoryName} ${agent.boardName}`;
}

function findAgent(agents: Agent[], arg: string): Agent | undefined {
  const lower = arg.trim().toLowerCase();
  if (!lower) return undefined;
  return agents.find((item) => item.id === arg || item.id.startsWith(arg) || item.name.toLowerCase() === lower || item.repositoryName.toLowerCase() === lower || item.boardName.toLowerCase() === lower)
    ?? agents.find((item) => labelsOf(item).some((label) => label.toLowerCase().includes(lower)));
}

function projectLabel(agent: Agent): string {
  return agent.repositoryName || agent.boardName || "no project";
}

function askWhich(agents: Agent[], verb: string): string {
  if (agents.length === 0) return "No agents are configured yet.";
  const lines = agents.map((agent) => `${agent.name} — ${projectLabel(agent)} [${agent.status}]`);
  return `Which agent and project should I ${verb}?\n${lines.join("\n")}\nSay: ${verb} ${agents[0]?.name ?? "the agent"}`;
}

function resolveOne(agents: Agent[], arg: string, verb: string): Agent | string {
  if (arg) return findAgent(agents, arg) ?? "Agent not found. Say “commands” to see the agents and projects.";
  if (agents.length === 1) return agents[0]!;
  return askWhich(agents, verb);
}

function commandList(agents: Agent[]): string {
  const projects = agents.length === 0 ? "No agents yet." : agents.map((agent) => `${agent.name} — ${projectLabel(agent)} [${agent.status}]`).join("\n");
  return [
    "Agents and projects",
    projects,
    "",
    "Commands",
    "/commands — show this list",
    "/agents — agents and their projects",
    "/start <agent> — start the agent and push it to work",
    "/push <agent> — push the agent to take the next step",
    "/pause <agent>",
    "/resume <agent>",
    "/restart <agent>",
    "/stop <agent> — stop the agent",
    "/tick <agent> — queue one tick",
    "/sync <agent> — sync tickets from the board",
    "/status [agent]",
    "/howfar [agent] — percent done and how long the Doing ticket has been running",
    "/backlog [agent] — tickets in Backlog",
    "/done [agent] — what has been done",
    "/problems [agent]",
    "/approve <ticket>",
    "/reject <ticket>",
    "",
    "You can also write: start, pause, resume, restart, stop, tick, sync, list the backlog, what has been done, any problems, what are you doing, howfar, work on <ticket>.",
    "Name the agent when more than one project is available.",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function scopedReport(store: PlatformStore, agents: Agent[], arg: string, command: string): Promise<string> {
  const named = arg ? findAgent(agents, arg) : undefined;
  if (arg && !named) return "Agent not found.";
  const targets = named ? [named] : agents;
  if (targets.length === 0) return "No agents.";
  const lines = [];
  for (const agent of targets) lines.push(await reportFor(store, agent, command));
  return lines.join("\n\n");
}

async function progressReport(store: PlatformStore, agents: Agent[], query: string): Promise<string> {
  const named = query ? findAgent(agents, query) : undefined;
  const targets = named ? [named] : agents;
  const ticketQuery = named ? "" : query;
  if (targets.length === 0) return "No agents.";
  const lines = [];
  for (const agent of targets) {
    const text = describeProgress(await store.listTasks(agent.id), await store.listRuns(agent.id), ticketQuery, new Date());
    if (ticketQuery && text === `Ticket ${ticketQuery} was not found.`) continue;
    lines.push(targets.length > 1 ? `${agent.name}\n${text}` : text);
  }
  if (lines.length === 0) return ticketQuery ? `Ticket ${ticketQuery} was not found.` : "Nothing is in Doing.";
  return lines.join("\n\n");
}

async function reportFor(store: PlatformStore, agent: Agent, command: string): Promise<string> {
  const tasks = await store.listTasks(agent.id);
  if (command === "/backlog") return `${agent.name}\n${describeColumn(tasks, "backlog")}`;
  if (command === "/done") return `${agent.name}\n${describeColumn(tasks, "done", 12)}`;
  if (command === "/problems") return describeProblems(agent, tasks);
  return describeProject(agent, tasks, new Date());
}

async function runAgent(store: PlatformStore, agent: Agent, hooks: TelegramHooks, action: "started" | "pushed" | "restarted"): Promise<string> {
  agent.status = "running";
  agent.updatedAt = nowIso();
  await store.updateAgent(agent);
  await hooks.enqueue?.(agent.id);
  const project = projectLabel(agent);
  if (action === "pushed") return `${agent.name} is pushed to work on ${project}.`;
  if (action === "restarted") return `${agent.name} restarted on ${project} and is pushed to work.`;
  return `${agent.name} started on ${project} and is pushed to work.`;
}

async function setStatus(store: PlatformStore, agent: Agent, status: "running" | "paused" | "stopped", hooks?: TelegramHooks): Promise<string> {
  agent.status = status;
  agent.updatedAt = nowIso();
  await store.updateAgent(agent);
  if (status === "running") await hooks?.enqueue?.(agent.id);
  return `${agent.name} is ${status}.`;
}

async function tickAgent(agent: Agent, hooks: TelegramHooks): Promise<string> {
  await hooks.enqueue?.(agent.id);
  return `${agent.name} is queued for a tick on ${projectLabel(agent)}.`;
}

async function syncBoard(store: PlatformStore, agent: Agent, masterKey: string): Promise<string> {
  const local = await store.listTasks(agent.id);
  if (agent.provider === "none" || !agent.boardId) return `${agent.name} has no board to sync. ${local.length} ticket${local.length === 1 ? " is" : "s are"} already stored.`;
  if (!agent.credentialSecretId) return "Board credentials are not configured.";
  const workflow = await store.getWorkflow(agent.id);
  const secret = await store.getSecret(agent.credentialSecretId);
  if (!workflow || !secret) return "Board credentials are not configured.";
  let credentials: { key: string; token: string };
  try {
    credentials = parseCredentials(decryptSecret(secret, masterKey), agent.provider);
  } catch {
    return "Board credentials could not be read.";
  }
  if (!credentials.token) return "Board credentials are not configured.";
  if (agent.provider === "trello" && !credentials.key) return "Trello needs the API key and token saved together as JSON before tickets can be loaded.";
  const board = createBoardClient({ provider: agent.provider, boardId: agent.boardId, credentials });
  if (!board) return "Board credentials are not configured.";
  try {
    const merged = mergeCards(agent.id, local, await board.listCards(), workflow.columns);
    for (const task of merged.tasks) await store.saveTask(task);
    for (const approval of merged.approvals) {
      await store.createApproval({
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
    const saved = await store.listTasks(agent.id);
    const unmapped = [...new Set(merged.notices.filter((notice) => notice.message.startsWith("column ")).map((notice) => notice.message.replace(/^column /, "").replace(/ is not mapped$/, "").trim()).filter(Boolean))];
    if (unmapped.length > 0 && merged.tasks.length === local.length) {
      const names = unmapped.join(", ");
      return `These board columns are not mapped yet: ${names}.`;
    }
    return `${agent.name} synced ${saved.length} ticket${saved.length === 1 ? "" : "s"} from the board.`;
  } catch {
    return "The board did not return its tickets.";
  }
}

async function shiftAcross(store: PlatformStore, agents: Agent[], query: string, masterKey: string, hooks: TelegramHooks): Promise<string> {
  const located = await locate(store, agents, query);
  if (typeof located === "string") return located;
  const tasks = await store.listTasks(located.agent.id);
  const shifted = shiftToTicket(tasks, located.task, nowIso());
  for (const task of shifted.changed) await store.saveTask(task);
  if (shifted.changed.length > 0 && located.agent.status === "running") await hooks.enqueue?.(located.agent.id);
  const moved = await moveBoard(store, located.agent, shifted.changed, masterKey);
  return `${located.agent.name}: ${shifted.reply}${moved}`;
}

async function describeMatch(agents: Agent[], store: PlatformStore, query: string, strict: boolean): Promise<string> {
  const located = await locate(store, agents, query);
  if (typeof located === "string") {
    if (located.startsWith("Several")) return located;
    return strict ? located : "";
  }
  return `${located.agent.name}\n${describeTicket(located.task)}\nSay “work on ${located.task.title}” to switch to it.`;
}

async function decideAcross(store: PlatformStore, agents: Agent[], query: string, decision: "approved" | "rejected", masterKey: string): Promise<string> {
  if (!query) {
    const reviews: { agent: Agent; task: Task }[] = [];
    for (const agent of agents) {
      for (const task of await store.listTasks(agent.id)) {
        if (task.stage === "review") reviews.push({ agent, task });
      }
    }
    if (reviews.length === 0) return "Nothing is in Review.";
    if (reviews.length > 1) return `Name the ticket to ${decision === "approved" ? "approve" : "reject"}: ${reviews.map((item) => ticketLabel(item.task)).join(", ")}.`;
    return decideTask(store, agents, reviews[0]!.task, decision, masterKey);
  }
  const located = await locate(store, agents, query);
  if (typeof located === "string") return located;
  return decideTask(store, agents, located.task, decision, masterKey);
}

async function locate(store: PlatformStore, agents: Agent[], query: string): Promise<{ agent: Agent; task: Task } | string> {
  const found: { agent: Agent; task: Task }[] = [];
  for (const agent of agents) {
    for (const task of findTickets(await store.listTasks(agent.id), query)) found.push({ agent, task });
  }
  if (found.length === 1) return found[0]!;
  if (found.length === 0) return `Ticket ${query} was not found.`;
  return `Several tickets match “${query}”: ${found.map((item) => `${item.agent.name} ${ticketLabel(item.task)}`).join(", ")}. Name one of them.`;
}

async function decideTask(store: PlatformStore, agents: Agent[], task: Task, decision: "approved" | "rejected", masterKey: string): Promise<string> {
  let next: Task;
  try {
    next = decision === "approved" ? approveTask(task, { source: "telegram" }) : rejectTask(task, "rejected from Telegram");
  } catch (error) {
    return error instanceof WorkflowError ? error.message : "That ticket is not in Review.";
  }
  await store.createApproval({
    id: newId(),
    taskId: task.id,
    agentId: task.agentId,
    source: "telegram",
    decision,
    actor: "telegram",
    comment: decision,
    createdAt: nowIso(),
  });
  await store.saveTask(next);
  const owner = agents.find((item) => item.id === task.agentId);
  const moved = owner ? await moveBoard(store, owner, [next], masterKey) : "";
  return `${task.title} is ${next.stage}.${moved}`;
}

async function moveBoard(store: PlatformStore, owner: Agent, tasks: Task[], masterKey: string): Promise<string> {
  if (tasks.length === 0 || !owner.credentialSecretId) return "";
  const workflow = await store.getWorkflow(owner.id);
  const secret = await store.getSecret(owner.credentialSecretId);
  if (!workflow || !secret) return "";
  const board = createBoardClient({
    provider: owner.provider,
    boardId: owner.boardId,
    credentials: parseCredentials(decryptSecret(secret, masterKey), owner.provider),
  });
  if (!board) return "";
  let failed = false;
  for (const task of tasks) {
    const column = columnForStage(workflow.columns, task.stage);
    if (!column) continue;
    const moved = await board.moveCard(task.externalId, column).then(() => true).catch(() => false);
    if (!moved) failed = true;
  }
  return failed ? " The board column was not updated." : "";
}
