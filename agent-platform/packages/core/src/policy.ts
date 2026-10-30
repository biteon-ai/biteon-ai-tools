import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { PolicyError } from "./errors.js";
import { MERGE_BLOCKED } from "./merge-guard.js";

const ALLOWED_BINS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "node",
  "python",
  "python3",
  "pytest",
  "go",
  "cargo",
  "git",
  "ls",
  "rg",
  "cat",
  "make",
  "tsc",
]);

const ALLOWED_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "checkout",
  "switch",
  "add",
  "commit",
  "push",
  "fetch",
  "pull",
  "clone",
  "rev-parse",
  "ls-files",
  "remote",
  "init",
  "config",
  "merge-tree",
  "merge-base",
  "merge",
  "stash",
  "worktree",
]);

export function resolveInWorkspace(workspace: string, input: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PolicyError("path escapes workspace");
  }
  const relative = path.relative(root, resolved);
  if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) {
    throw new PolicyError("refusing to modify .git");
  }
  let current = resolved;
  while (current.startsWith(root)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const real = realpathSync(current);
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new PolicyError("symlink escapes workspace");
        }
      }
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export function assertGitAllowed(args: string[], options?: { humanMergeApproval?: boolean }): void {
  if (args.length === 0) throw new PolicyError("empty git command");
  const [sub, ...rest] = args;
  if (sub === "merge" && !options?.humanMergeApproval) throw new PolicyError(MERGE_BLOCKED);
  if (sub === "pull" && !rest.includes("--ff-only")) throw new PolicyError("git pull must be fast-forward only");
  if (!sub || !ALLOWED_GIT.has(sub)) throw new PolicyError(`git ${sub ?? ""} is not allowed`);
  if (sub === "worktree") {
    const action = rest[0];
    if (!action || !["list", "remove", "prune"].includes(action)) {
      throw new PolicyError("git worktree only allows list, remove, or prune");
    }
    if (action === "remove") {
      const bad = rest.slice(1).some((arg) => {
        const lower = arg.toLowerCase();
        return lower === "--force-with-lease" || lower === "--no-verify" || lower === "--mirror" || lower === "--hard" || lower === "--amend" || arg.startsWith("+");
      });
      if (bad) throw new PolicyError("destructive git flag is not allowed");
    } else if (rest.slice(1).some((arg) => {
      const lower = arg.toLowerCase();
      return lower === "--force" || lower === "-f" || lower.startsWith("--force") || lower === "--no-verify" || arg.startsWith("+");
    })) {
      throw new PolicyError("destructive git flag is not allowed");
    }
  } else {
    const forbidden = rest.some((arg) => {
      const lower = arg.toLowerCase();
      return (
        lower === "--force" ||
        lower === "-f" ||
        lower === "--force-with-lease" ||
        lower === "--no-verify" ||
        lower === "--mirror" ||
        lower === "--hard" ||
        lower === "--amend" ||
        lower.startsWith("--force") ||
        arg.startsWith("+")
      );
    });
    if (forbidden) throw new PolicyError("destructive git flag is not allowed");
  }
  if (sub === "push" && rest.some((arg) => arg === "--delete" || arg === ":")) {
    throw new PolicyError("deleting remote branches is not allowed");
  }
  if (sub === "branch" && rest.some((arg) => arg === "-D" || arg === "-d")) {
    throw new PolicyError("deleting branches is not allowed");
  }
  if (sub === "reset" || sub === "clean" || sub === "rebase" || sub === "filter-branch") {
    throw new PolicyError(`git ${sub} is not allowed`);
  }
  if ((sub === "checkout" || sub === "restore" || sub === "switch") && rest.includes("--")) {
    throw new PolicyError("discarding working tree changes is not allowed");
  }
  if (sub === "config" && rest.some((arg) => arg.toLowerCase().includes("hook"))) {
    throw new PolicyError("changing git hook configuration is not allowed");
  }
}

export function assertCommandAllowed(argv: string[], workspace: string, options?: { humanMergeApproval?: boolean }): void {
  if (argv.length === 0) throw new PolicyError("empty command");
  const [bin, ...args] = argv;
  if (!bin || bin.includes("/") || bin.includes("..") || bin.includes("\\")) {
    throw new PolicyError("command must be a bare executable name");
  }
  if (!ALLOWED_BINS.has(bin)) throw new PolicyError(`${bin} is not allowed`);
  for (const arg of argv) {
    if (/[|&;`$<>\n]/.test(arg)) throw new PolicyError("shell composition is not allowed");
  }
  if (bin === "git") assertGitAllowed(args, options);
  for (const arg of args) {
    if (arg.startsWith("/") || /^[A-Za-z]:\\/.test(arg)) {
      resolveInWorkspace(workspace, arg);
    }
  }
}

export function assertAgentWorkspace(agentWorkspace: string, candidate: string): void {
  resolveInWorkspace(agentWorkspace, candidate);
}
