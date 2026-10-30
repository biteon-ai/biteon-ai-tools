import { createServer } from "node:http";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { decryptSecret, loadPlatformEnv, shouldSendImmediately } from "@agent-platform/core";
import { PostgresStore } from "@agent-platform/db";
import { createPairingStore, pollTelegram, sendTelegramMessage } from "@agent-platform/integrations";
import { consumeTelegramUpdates } from "./telegram-updates.js";
import { syncConnectedBoards } from "./board-poll.js";
import { AGENT_TICK_QUEUE, newId, nowIso } from "@agent-platform/shared";
import { executeTick, runtimeFromEnv } from "./tick-runner.js";

const env = loadPlatformEnv();
const store = new PostgresStore(env.DATABASE_URL);
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(AGENT_TICK_QUEUE, { connection });
const runtime = runtimeFromEnv(env);
const pairing = createPairingStore({
  get: (key) => connection.get(key),
  set: (key, value, _mode, seconds) => connection.set(key, value, "EX", seconds),
  ttl: (key) => connection.ttl(key),
});
let telegramOffset = 0;
let running = true;

// Drop locks left by a previous worker process so a restart cannot stall all ticks.
void connection.keys("lock:agent-tick:*").then(async (keys) => {
  if (keys.length > 0) await connection.del(...keys);
}).catch(() => undefined);

const worker = new Worker(AGENT_TICK_QUEUE, async (job) => {
  if (job.name === "board-sync" || job.name === "trello-board-sync") {
    await syncConnectedBoards(store, env.APP_MASTER_KEY);
    return;
  }
  const agentId = String(job.data.agentId ?? "");
  if (!agentId) return;
  // Serialize ticks per agent even when WORKER_CONCURRENCY > 1.
  const lockKey = `lock:agent-tick:${agentId}`;
  const lockToken = `${job.id ?? "job"}:${Date.now()}`;
  const locked = await connection.set(lockKey, lockToken, "EX", 900, "NX");
  if (!locked) return;
  try {
    await executeTick({ store, agentId, runtime, masterKey: env.APP_MASTER_KEY });
  } finally {
    const current = await connection.get(lockKey);
    if (current === lockToken) await connection.del(lockKey);
  }
}, { connection, concurrency: env.WORKER_CONCURRENCY });

void queue.upsertJobScheduler("trello-board-sync", { every: 60_000 }, {
  name: "board-sync",
  data: {},
  opts: { removeOnComplete: true, removeOnFail: 20 },
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "board sync schedule failed");
});

const timer = setInterval(() => {
  void scheduler().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "scheduler failed");
  });
}, env.TICK_INTERVAL_MS);

const telegramTimer = setInterval(() => {
  void telegramLoop().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "telegram failed");
  });
}, 5000);

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/ready") {
    void store.ping().then((database) => {
      response.writeHead(database ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: database ? "ok" : "degraded", database }));
    }).catch(() => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "degraded", database: false }));
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(env.WORKER_PORT, "0.0.0.0");

async function scheduler(): Promise<void> {
  const agents = await store.listAgents();
  const runningAgents = agents.filter((agent) => agent.status === "running");
  if (runningAgents.length > env.MAX_RUNNING_AGENTS) {
    const recent = await store.listNotifications(10);
    const alreadyReported = recent.some((item) => item.title === "Concurrency limit" && Date.now() - Date.parse(item.createdAt) < 60 * 60 * 1000);
    if (!alreadyReported) {
      await store.addNotification({
        id: newId(),
        agentId: null,
        taskId: null,
        severity: "warning",
        title: "Concurrency limit",
        body: `${runningAgents.length} agents are running; the scheduler will tick ${env.MAX_RUNNING_AGENTS}.`,
        links: [],
        delivered: false,
        createdAt: nowIso(),
      });
    }
  }
  for (const agent of runningAgents.slice(0, env.MAX_RUNNING_AGENTS)) {
    const existing = await queue.getJob(agent.id).catch(() => null);
    const state = existing ? await existing.getState().catch(() => "") : "";
    if (existing && (state === "failed" || state === "completed")) await existing.remove().catch(() => undefined);
    await queue.add("tick", { agentId: agent.id }, { jobId: agent.id, removeOnComplete: true, removeOnFail: true }).catch(() => undefined);
  }
  const memory = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const agentStats = [];
  for (const agent of runningAgents.slice(0, env.MAX_RUNNING_AGENTS)) {
    agentStats.push({ id: agent.id, ...(await runtime.stats(agent.id)) });
  }
  await store.saveHeartbeat({
    id: "worker",
    updatedAt: nowIso(),
    payload: { runtimeMode: runtime.mode, rssMb: memory, agentStats },
  });
}

async function telegramLoop(): Promise<void> {
  if (!running) return;
  const config = await store.getTelegramConfig();
  if (!config?.botSecretId) return;
  const secret = await store.getSecret(config.botSecretId);
  if (!secret) return;
  const token = decryptSecret(secret, env.APP_MASTER_KEY);
  if (config.enabled && config.chatId) await deliverTelegram(token, config);
  const updates = await pollTelegram(token, telegramOffset);
  for (const update of updates) telegramOffset = update.update_id + 1;
  await consumeTelegramUpdates({
    store,
    pairing,
    token,
    updates,
    masterKey: env.APP_MASTER_KEY,
    enqueue: async (agentId) => {
      await queue.add("tick", { agentId }, { jobId: agentId, removeOnComplete: true, removeOnFail: 20 });
    },
  });
}

async function deliverTelegram(token: string, config: NonNullable<Awaited<ReturnType<typeof store.getTelegramConfig>>>): Promise<void> {
  if (!config.chatId) return;
  const pending = await store.listUndelivered();
  const immediate = pending.filter((item) => shouldSendImmediately(item.severity, config.minSeverity));
  for (const item of immediate) {
    await sendTelegramMessage(token, config.chatId, `${item.title}\n${item.body}`);
    await store.markDelivered([item.id]);
  }
  const digestDue = !config.lastDigestAt || Date.now() - Date.parse(config.lastDigestAt) >= config.digestMinutes * 60000;
  const routine = pending.filter((item) => !immediate.includes(item));
  if (digestDue && routine.length > 0) {
    const body = routine.map((item) => `${item.title}: ${item.body}`).join("\n\n").slice(0, 4000);
    await sendTelegramMessage(token, config.chatId, `Digest\n${body}`);
    await store.markDelivered(routine.map((item) => item.id));
    config.lastDigestAt = nowIso();
    await store.saveTelegramConfig(config);
  }
}

async function shutdown(): Promise<void> {
  running = false;
  clearInterval(timer);
  clearInterval(telegramTimer);
  await worker.close();
  await queue.close();
  await connection.quit();
  server.close();
  await store.close();
}

process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
