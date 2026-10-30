import { Queue } from "bullmq";
import IORedis from "ioredis";
import { AGENT_TICK_QUEUE } from "@agent-platform/shared";

export interface TickQueue {
  enqueue(agentId: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function createTickQueue(redisUrl: string): TickQueue & { close(): Promise<void> } {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(AGENT_TICK_QUEUE, { connection });
  return {
    async enqueue(agentId: string) {
      // One tick job per agent. Parallel manual+scheduler jobs shared the same
      // workspace and raced on .git/index.lock.
      const existing = await queue.getJob(agentId).catch(() => null);
      const state = existing ? await existing.getState().catch(() => "") : "";
      if (existing && (state === "failed" || state === "completed")) {
        await existing.remove().catch(() => undefined);
      }
      await queue.add("tick", { agentId }, {
        jobId: agentId,
        removeOnComplete: true,
        removeOnFail: 20,
      }).catch(() => undefined);
    },
    async ping() {
      return (await connection.ping()) === "PONG";
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
