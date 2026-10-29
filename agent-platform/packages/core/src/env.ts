import { z } from "zod";
import { EXAMPLE_MASTER_KEY } from "@agent-platform/shared";

export const platformEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_MASTER_KEY: z.string().min(32),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),
  SESSION_SECRET: z.string().min(16),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  WORKSPACES_DIR: z.string().min(1).default("/var/lib/agent-platform/workspaces"),
  API_PORT: z.coerce.number().default(4000),
  WORKER_PORT: z.coerce.number().default(4001),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_RUNNING_AGENTS: z.coerce.number().int().positive().default(4),
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DOCKER_RUNTIME: z.enum(["true", "false"]).default("false"),
  AGENT_RUNTIME_IMAGE: z.string().default("agent-platform-runtime:local"),
  AGENT_DOCKER_NETWORK: z.string().default("agent-platform-agents"),
  AGENT_CONTAINER_MEMORY: z.string().default("1g"),
  AGENT_CONTAINER_CPUS: z.string().default("1"),
  OLLAMA_BASE_URL: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  CURSOR_API_KEY: z.string().default(""),
  CODEX_API_KEY: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  APP_PUBLIC_URL: z.string().default(""),
});

export type PlatformEnv = z.infer<typeof platformEnvSchema>;

export function loadPlatformEnv(source: NodeJS.ProcessEnv = process.env): PlatformEnv {
  const parsed = platformEnvSchema.safeParse(source);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "env").join(", ");
    throw new Error(`invalid platform environment: ${paths}`);
  }
  return parsed.data;
}

export function masterKeyIsExample(masterKey: string): boolean {
  return masterKey === EXAMPLE_MASTER_KEY;
}
