import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodeExecutor, ExecutorResult, ExecutorRun } from "@agent-platform/shared";
import { resolveInWorkspace } from "@agent-platform/core";

export class FakeExecutor implements CodeExecutor {
  readonly id = "fake";
  readonly capabilities = { localModels: false, gitPush: false, opensPullRequests: false, available: true };

  async run(input: ExecutorRun): Promise<ExecutorResult> {
    await input.onProgress?.({ kind: "thinking", text: "Planning the next edits for this ticket." });
    await input.onProgress?.({ kind: "assistant", text: "Writing AGENT_WORK.md marker files." });
    const entries = await readdir(input.workspaceDir, { withFileTypes: true }).catch(() => []);
    const directories = entries
      .filter((entry) => entry.isDirectory() && (entry.name === "repo-primary" || entry.name.startsWith("repo-secondary")))
      .map((entry) => entry.name)
      .sort();
    const relativeFiles = directories.length > 0 ? directories.map((directory) => `${directory}/AGENT_WORK.md`) : ["AGENT_WORK.md"];
    for (const relative of relativeFiles) {
      const target = resolveInWorkspace(input.workspaceDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `Task ${input.taskId}\n`, "utf8");
      await input.onProgress?.({ kind: "tool", text: `Wrote ${relative}`, tool: "write", status: "completed" });
    }
    await input.onProgress?.({ kind: "status", text: "Fake executor finished", status: "FINISHED" });
    return {
      status: "succeeded",
      summary: `Recorded work for ${input.taskId}`,
      tokensIn: 0,
      tokensOut: 0,
      modelId: "fake",
      costClass: "none",
      checkpoint: { step: (input.checkpoint?.step ?? 0) + 1, note: "fake executor wrote AGENT_WORK.md", ownedFiles: relativeFiles },
    };
  }

  async cancel(): Promise<void> {}
}
