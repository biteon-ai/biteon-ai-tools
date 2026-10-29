import { hashPassword, loadPlatformEnv, masterKeyIsExample } from "@agent-platform/core";
import { PostgresStore, migrate } from "@agent-platform/db";
import { createPairingStore } from "@agent-platform/integrations";
import { newId, nowIso } from "@agent-platform/shared";
import IORedis from "ioredis";
import { createTickQueue } from "./queue.js";
import { buildServer } from "./server.js";

const env = loadPlatformEnv();
await migrate(env.DATABASE_URL);
const store = new PostgresStore(env.DATABASE_URL);
if ((await store.countUsers()) === 0) {
  await store.createUser({
    id: newId(),
    email: env.ADMIN_EMAIL.toLowerCase(),
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    createdAt: nowIso(),
  });
}
const queue = createTickQueue(env.REDIS_URL);
const pairingRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const pairing = createPairingStore({
  get: (key) => pairingRedis.get(key),
  set: (key, value, _mode, seconds) => pairingRedis.set(key, value, "EX", seconds),
  ttl: (key) => pairingRedis.ttl(key),
});
const app = buildServer({ store, env, queue, pairing, logger: true });
if (masterKeyIsExample(env.APP_MASTER_KEY)) {
  app.log.warn("APP_MASTER_KEY is still the example value from .env.example");
}
await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
