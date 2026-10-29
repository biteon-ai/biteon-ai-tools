import type { CodeExecutor, ExecutorResult, ExecutorRun } from "@agent-platform/shared";
import { redact } from "@agent-platform/core";

interface CursorModule {
  Agent: {
    create(options: {
      apiKey: string;
      model: { id: string };
      local: { cwd: string; settingSources?: string[] };
    }): Promise<{
      agentId: string;
      send(prompt: string): Promise<{ id?: string; wait(): Promise<{ status: string; id: string; result?: string }> }>;
      [Symbol.asyncDispose](): Promise<void>;
    }>;
  };
  CursorAgentError: new (message?: string) => Error & { isRetryable?: boolean };
}

export class CursorSdkExecutor implements CodeExecutor {
  readonly id = "cursor";
  readonly capabilities = { localModels: false, gitPush: true, opensPullRequests: false, available: true };

  constructor(private readonly load: () => Promise<CursorModule> = () => import("@cursor/sdk")) {}

  async cancel(): Promise<void> {}

  async run(input: ExecutorRun): Promise<ExecutorResult> {
    if (!input.model.apiKey) {
      return failed(input, "Cursor API key is not configured");
    }
    let sdk: CursorModule;
    try {
      sdk = await this.load();
    } catch (error) {
      return failed(input, `Cursor SDK is unavailable: ${redact(error instanceof Error ? error.message : "import failed")}`);
    }
    try {
      const agent = await sdk.Agent.create({
        apiKey: input.model.apiKey,
        model: { id: cursorModelId(input.model.modelId) },
        local: { cwd: input.workspaceDir, settingSources: [] },
      });
      try {
        const run = await agent.send(input.prompt);
        const result = await run.wait();
        if (result.status === "error") {
          return failed(input, `Cursor run ${result.id} failed`, result.id);
        }
        return {
          status: "succeeded",
          summary: result.result || `Cursor run ${result.id} finished`,
          tokensIn: 0,
          tokensOut: 0,
          modelId: input.model.modelId,
          costClass: "paid",
          checkpoint: { step: (input.checkpoint?.step ?? 0) + 1, note: result.id, ownedFiles: input.checkpoint?.ownedFiles ?? [] },
        };
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    } catch (error) {
      const retryable = error instanceof sdk.CursorAgentError ? error.isRetryable : false;
      return failed(input, `Cursor startup failed (retryable=${String(retryable)}): ${redact(error instanceof Error ? error.message : "unknown")}`);
    }
  }
}

function failed(input: ExecutorRun, error: string, note = error): ExecutorResult {
  return {
    status: "error",
    summary: error,
    tokensIn: 0,
    tokensOut: 0,
    modelId: input.model.modelId,
    costClass: "paid",
    checkpoint: input.checkpoint,
    error: note,
  };
}

/** Cursor SDK model ids differ from some catalog aliases (e.g. auto-smart → default). */
function cursorModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed || /^(auto|auto-smart|cursor-auto)$/i.test(trimmed)) return "default";
  return trimmed;
}
