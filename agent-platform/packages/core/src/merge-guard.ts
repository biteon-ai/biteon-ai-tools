import type { Approval } from "@agent-platform/shared";
import { PolicyError } from "./errors.js";
import type { AgentRuntime, CommandResult } from "./runtime.js";

export const MERGE_BLOCKED = "Never allow the agent container to execute git merge develop or auto-merge a pull request without a human approval from the UI or Telegram /approve";

export function isAutoMergeCommand(argv: string[]): boolean {
  const [bin, ...args] = argv;
  if (!bin) return false;
  if (bin === "git" && args[0] === "merge") return true;
  if (bin === "gh" && args[0] === "pr" && args.includes("merge")) return true;
  if (bin === "glab" && args[0] === "mr" && args.includes("merge")) return true;
  const command = argv.join(" ").toLowerCase();
  return command.includes("merge develop") || command.includes("auto-merge") || command.includes("automerge");
}

export function hasHumanMergeApproval(approval: Pick<Approval, "decision" | "source"> | null | undefined): boolean {
  return Boolean(approval && approval.decision === "approved" && (approval.source === "ui" || approval.source === "telegram"));
}

export function assertAutoMergeAllowed(argv: string[], approval: Pick<Approval, "decision" | "source"> | null): void {
  if (!isAutoMergeCommand(argv)) return;
  if (!hasHumanMergeApproval(approval)) throw new PolicyError(MERGE_BLOCKED);
}

export function guardAgentMerges(runtime: AgentRuntime, lookup: () => Promise<Pick<Approval, "decision" | "source"> | null>): AgentRuntime {
  return {
    mode: runtime.mode,
    ensure: (agent) => runtime.ensure(agent),
    stop: (agentId) => runtime.stop(agentId),
    stats: (agentId) => runtime.stats(agentId),
    async exec(agentId, file, args, opts): Promise<CommandResult> {
      const argv = [file, ...args];
      if (isAutoMergeCommand(argv)) {
        assertAutoMergeAllowed(argv, await lookup());
        return runtime.exec(agentId, file, args, { ...opts, humanMergeApproval: true });
      }
      return runtime.exec(agentId, file, args, opts);
    },
  };
}
