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
      await queue.add("tick", { agentId }, {
        jobId: `manual-${agentId}-${Date.now()}`,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
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
