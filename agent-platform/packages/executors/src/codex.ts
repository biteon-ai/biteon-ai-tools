import type { CodeExecutor, ExecutorResult, ExecutorRun } from "@agent-platform/shared";
import { redact } from "@agent-platform/core";
import type { CommandResult } from "@agent-platform/core";

export interface CodexRunner {
  available(): Promise<boolean>;
  exec(workspace: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<CommandResult>;
}

export class CodexExecutor implements CodeExecutor {
  readonly id = "codex";
  capabilities = { localModels: false, gitPush: true, opensPullRequests: false, available: false };

  constructor(private readonly runner: CodexRunner) {}

  async cancel(): Promise<void> {}

  async run(input: ExecutorRun): Promise<ExecutorResult> {
    this.capabilities.available = await this.runner.available();
    if (!this.capabilities.available) {
      return errorResult(input, "Codex CLI is not installed");
    }
    if (!input.model.apiKey) return errorResult(input, "Codex API key is not configured");
    const args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      input.prompt,
    ];
    const result = await this.runner.exec(input.workspaceDir, args, { CODEX_API_KEY: input.model.apiKey }, input.limits.timeoutMs);
    if (result.code !== 0) {
      return errorResult(input, redact(result.stderr || result.stdout || `codex exited ${result.code}`));
    }
    return {
      status: "succeeded",
      summary: redact(result.stdout).slice(0, 4000) || "Codex finished",
      tokensIn: 0,
      tokensOut: 0,
      modelId: input.model.modelId || "codex",
      costClass: "paid",
      checkpoint: { step: (input.checkpoint?.step ?? 0) + 1, note: "codex exec", ownedFiles: input.checkpoint?.ownedFiles ?? [] },
    };
  }
}

function errorResult(input: ExecutorRun, error: string): ExecutorResult {
  return {
    status: "error",
    summary: error,
    tokensIn: 0,
    tokensOut: 0,
    modelId: input.model.modelId,
    costClass: "paid",
    checkpoint: input.checkpoint,
    error,
  };
}
