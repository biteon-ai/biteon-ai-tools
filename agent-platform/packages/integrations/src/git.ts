import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Agent, Task } from "@agent-platform/shared";
import { assertGitAllowed, checkoutPath, inferTaskCheckouts, redactGitArgs, workspaceCheckouts, type AgentRuntime, type Checkout } from "@agent-platform/core";
import { openLinkedChanges } from "./changes.js";

export class WorkspaceGit {
  constructor(private readonly runtime: AgentRuntime) {}

  async prepare(agent: Agent, task: Task, ownedFiles: string[], token = ""): Promise<{ branch: string; dirtyForeign: boolean }> {
    await this.runtime.ensure(agent);
    const all = this.checkouts(agent);
    const checkouts = inferTaskCheckouts(task, all);
    const base = agent.defaultBranch || "develop";
    // Empty branchName = Speckit mode: sync the base branch and let Speckit create NNN-name.
    const branch = task.branchName.trim();
    let dirtyForeign = false;
    for (const checkout of checkouts) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      if (checkout.directory) await mkdir(cwd, { recursive: true });
      await this.clearStaleIndexLock(cwd);
      await this.withIndexLockRetry(cwd, async () => {
        const hasGit = await this.exec(agent, ["rev-parse", "--is-inside-work-tree"], "", cwd);
        if (hasGit.code !== 0) {
          if (checkout.url) await this.exec(agent, ["clone", checkout.url, "."], token, cwd);
          else await this.exec(agent, ["init", "-b", base], "", cwd);
        }
        await this.ensureIdentity(agent, cwd);
        // Previous Cursor/Speckit runs often leave uncommitted WIP. Commit or stash it
        // before checkout so switching tickets does not fail with "local changes would be overwritten".
        await this.preserveDirtyWork(agent, cwd, branch || base);
        await this.updateFromOrigin(agent, cwd, base, token);
        if (!branch) {
          // Speckit will create/check out NNN-short-name from here.
          return;
        }
        // Cursor (and prior runs) may leave linked worktrees holding this branch.
        await this.releaseBranchWorktrees(agent, cwd, branch);
        const existing = await this.exec(agent, ["rev-parse", "--verify", "--quiet", branch], "", cwd);
        if (existing.code !== 0) await this.exec(agent, ["checkout", "-b", branch], "", cwd);
        else {
          await this.checkoutBranch(agent, cwd, branch);
          const remoteBranch = await this.exec(agent, ["rev-parse", "--verify", "--quiet", `origin/${branch}`], "", cwd);
          if (remoteBranch.code === 0) await this.exec(agent, ["pull", "--ff-only", "origin", branch], token, cwd);
        }
      });
      const status = await this.exec(agent, ["status", "--porcelain"], "", cwd);
      const dirty = status.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      const owned = new Set(filesForCheckout(checkout, ownedFiles));
      const foreign = dirty.filter((line) => {
        const file = line.slice(3).trim();
        return file && !owned.has(file);
      });
      if (foreign.length > 0) dirtyForeign = true;
    }
    return { branch, dirtyForeign };
  }

  async currentBranches(agent: Agent): Promise<string[]> {
    const branches: string[] = [];
    for (const checkout of this.checkouts(agent)) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      const current = await this.exec(agent, ["branch", "--show-current"], "", cwd);
      const name = current.stdout.trim();
      if (name) branches.push(name);
    }
    return branches;
  }

  async commitAndPush(agent: Agent, task: Task, ownedFiles: string[], message: string, token = ""): Promise<{ prUrl: string }> {
    const checkouts = this.checkouts(agent);
    const changed: Checkout[] = [];
    for (const checkout of checkouts) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      const current = await this.exec(agent, ["branch", "--show-current"], "", cwd);
      // Only publish checkouts that are actually on this ticket's branch.
      if (current.stdout.trim() !== task.branchName) continue;
      let files = filesForCheckout(checkout, ownedFiles);
      if (files.length === 0) {
        // Cursor checkpoints often omit ownedFiles — fall back to dirty paths.
        files = await this.dirtyFiles(agent, cwd);
      }
      await this.clearStaleIndexLock(cwd);
      await this.withIndexLockRetry(cwd, async () => {
        if (files.length > 0) {
          await this.exec(agent, ["add", "--", ...files], "", cwd);
          const committed = await this.exec(agent, ["commit", "-m", message], "", cwd);
          if (committed.code !== 0 && !committed.stdout.includes("nothing to commit") && !committed.stderr.includes("nothing to commit")) {
            throw new Error("git commit failed");
          }
        }
        const remote = await this.exec(agent, ["remote", "get-url", "origin"], "", cwd);
        if (remote.code !== 0) return;
        // Push even when there is nothing new to commit so earlier local WIP reaches GitHub.
        await this.exec(agent, ["push", "origin", `HEAD:refs/heads/${task.branchName}`], token, cwd);
        changed.push(checkout);
      });
    }
    let prUrl = task.prUrl;
    if (token && changed.length > 0) {
      const opened = await openLinkedChanges({
        token,
        targets: changed.map((checkout) => ({ name: checkout.name, host: checkout.host, apiOrigin: checkout.apiOrigin })),
        head: task.branchName,
        base: agent.defaultBranch || "develop",
        title: task.title,
        ticket: task.externalId,
        ticketUrl: task.url,
      });
      if (opened.length > 0) prUrl = opened.map((change) => change.url).join("\n");
    }
    return { prUrl };
  }

  async conflictCheck(agent: Agent, baseBranch: string): Promise<{ clean: boolean; detail: string }> {
    const base = baseBranch || "main";
    const details: string[] = [];
    for (const checkout of this.checkouts(agent)) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      const label = checkout.directory || checkout.name || ".";
      const head = await this.exec(agent, ["rev-parse", "--verify", "HEAD"], "", cwd);
      if (head.code !== 0) {
        details.push(`${label}: no commits yet, conflict dry-run skipped`);
        continue;
      }
      const local = await this.exec(agent, ["rev-parse", "--verify", "--quiet", base], "", cwd);
      const remote = local.code === 0 ? null : await this.exec(agent, ["rev-parse", "--verify", "--quiet", `origin/${base}`], "", cwd);
      const target = local.code === 0 ? base : remote && remote.code === 0 ? `origin/${base}` : "";
      if (!target) {
        details.push(`${label}: base branch ${base} is not present, conflict dry-run skipped`);
        continue;
      }
      const dryRun = await this.exec(agent, ["merge-tree", "--write-tree", "HEAD", target], "", cwd);
      details.push(`${label}: git merge-tree --write-tree HEAD ${target} exited ${dryRun.code}`);
      if (dryRun.code !== 0) return { clean: false, detail: details.join("; ") };
    }
    return { clean: true, detail: details.join("; ") || "conflict dry-run clean" };
  }

  async diff(agent: Agent): Promise<{ diff: string; files: string[] }> {
    const parts: string[] = [];
    const files: string[] = [];
    for (const checkout of this.checkouts(agent)) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      const prefix = checkout.directory ? `${checkout.directory}/` : "";
      const diff = await this.exec(agent, ["diff", "--", "."], "", cwd);
      const staged = await this.exec(agent, ["diff", "--cached", "--", "."], "", cwd);
      const names = await this.exec(agent, ["status", "--porcelain"], "", cwd);
      if (diff.stdout.trim()) parts.push(diff.stdout);
      if (staged.stdout.trim()) parts.push(staged.stdout);
      for (const line of names.stdout.split("\n")) {
        const file = line.slice(3).trim();
        if (file) files.push(`${prefix}${file}`);
      }
    }
    return { diff: parts.join("\n"), files };
  }

  private checkouts(agent: Agent): Checkout[] {
    const checkouts = workspaceCheckouts(agent);
    if (checkouts.length > 0) return checkouts;
    return [{ role: "primary", name: "", url: "", directory: "", host: "github", apiOrigin: "https://api.github.com" }];
  }

  private async dirtyFiles(agent: Agent, cwd: string): Promise<string[]> {
    const status = await this.exec(agent, ["status", "--porcelain"], "", cwd);
    const files: string[] = [];
    for (const line of status.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // status -z is not used; handle renames "R  old -> new" by taking the new path.
      const pathPart = trimmed.slice(2).trim();
      const renamed = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop()!.trim() : pathPart;
      if (renamed) files.push(renamed);
    }
    return files;
  }

  private async clearStaleIndexLock(cwd: string, force = false): Promise<void> {
    const lockPath = path.join(cwd, ".git", "index.lock");
    try {
      const info = await stat(lockPath);
      if (force || Date.now() - info.mtimeMs > 15_000) await unlink(lockPath);
    } catch {
      // no lock, or already gone
    }
  }

  private async withIndexLockRetry(cwd: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/index\.lock/i.test(message)) throw error;
      await this.clearStaleIndexLock(cwd, true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await work();
    }
  }

  private async checkoutBranch(agent: Agent, cwd: string, branch: string): Promise<void> {
    try {
      await this.exec(agent, ["checkout", branch], "", cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already checked out/i.test(message)) throw error;
      await this.releaseBranchWorktrees(agent, cwd, branch);
      await this.exec(agent, ["checkout", branch], "", cwd);
    }
  }

  /** Drop sibling worktrees that pin `branch` so the main checkout can use it. */
  private async releaseBranchWorktrees(agent: Agent, cwd: string, branch: string): Promise<void> {
    const listed = await this.exec(agent, ["worktree", "list", "--porcelain"], "", cwd);
    if (listed.code !== 0) return;
    const blocks = listed.stdout.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const branchRef = `refs/heads/${branch}`;
    const workspaceRoot = path.resolve(agent.workspacePath);
    for (const block of blocks) {
      const lines = block.split("\n");
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const worktreePath = worktreeLine?.slice("worktree ".length).trim();
      const heldBranch = branchLine?.slice("branch ".length).trim();
      if (!worktreePath || heldBranch !== branchRef) continue;
      if (path.resolve(worktreePath) === path.resolve(cwd)) continue;
      if (!path.resolve(worktreePath).startsWith(workspaceRoot + path.sep)) continue;
      await this.ensureIdentity(agent, worktreePath);
      await this.preserveDirtyWork(agent, worktreePath, branch);
      const removed = await this.exec(agent, ["worktree", "remove", "--force", worktreePath], "", cwd);
      if (removed.code !== 0) {
        throw new Error(removed.stderr.trim() || `git worktree remove failed for ${worktreePath}`);
      }
    }
    await this.exec(agent, ["worktree", "prune"], "", cwd);
  }

  private async preserveDirtyWork(agent: Agent, cwd: string, nextBranch: string): Promise<void> {
    const status = await this.exec(agent, ["status", "--porcelain"], "", cwd);
    const dirty = status.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (dirty.length === 0) return;
    const current = await this.exec(agent, ["branch", "--show-current"], "", cwd);
    const currentBranch = current.stdout.trim();
    await this.ensureIdentity(agent, cwd);
    if (currentBranch.startsWith("agent/") || currentBranch === nextBranch) {
      await this.exec(agent, ["add", "-A"], "", cwd);
      const committed = await this.exec(
        agent,
        ["commit", "-m", currentBranch === nextBranch
          ? `wip: keep unfinished agent work on ${currentBranch || nextBranch}`
          : `wip: park unfinished agent work before switching from ${currentBranch} to ${nextBranch}`],
        "",
        cwd,
      );
      if (committed.code !== 0 && !committed.stdout.includes("nothing to commit") && !committed.stderr.includes("nothing to commit")) {
        throw new Error(committed.stderr.trim() || "git commit failed while preserving dirty workspace");
      }
      return;
    }
    // On a shared base branch, stash including untracked so checkout can proceed.
    const stashed = await this.exec(agent, ["stash", "push", "-u", "-m", `agent-platform auto-stash before ${nextBranch}`], "", cwd);
    if (stashed.code !== 0) {
      throw new Error(stashed.stderr.trim() || "git stash failed while preserving dirty workspace");
    }
  }

  private async updateFromOrigin(agent: Agent, cwd: string, base: string, token: string): Promise<void> {
    const remote = await this.exec(agent, ["remote", "get-url", "origin"], "", cwd);
    if (remote.code !== 0) {
      const localBase = await this.exec(agent, ["rev-parse", "--verify", "--quiet", base], "", cwd);
      if (localBase.code === 0) await this.exec(agent, ["checkout", base], "", cwd);
      return;
    }
    await this.exec(agent, ["fetch", "origin"], token, cwd);
    const originBase = await this.exec(agent, ["rev-parse", "--verify", "--quiet", `origin/${base}`], "", cwd);
    if (originBase.code === 0) {
      await this.exec(agent, ["checkout", "-B", base, `origin/${base}`], "", cwd);
      return;
    }
    const localBase = await this.exec(agent, ["rev-parse", "--verify", "--quiet", base], "", cwd);
    if (localBase.code === 0) await this.exec(agent, ["checkout", base], "", cwd);
  }

  private async ensureIdentity(agent: Agent, cwd: string): Promise<void> {
    const name = await this.exec(agent, ["config", "user.name"], "", cwd);
    if (!name.stdout.trim()) await this.exec(agent, ["config", "user.name", agent.name], "", cwd);
    const email = await this.exec(agent, ["config", "user.email"], "", cwd);
    if (!email.stdout.trim()) await this.exec(agent, ["config", "user.email", "agent@localhost"], "", cwd);
  }

  private async exec(agent: Agent, args: string[], token = "", cwd = agent.workspacePath) {
    assertGitAllowed(args);
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
    // http.extraHeader is ignored by some git/curl builds; url.insteadOf reliably
    // injects the PAT for https remotes without embedding it in stored remotes.
    if (token && (args[0] === "clone" || args[0] === "push" || args[0] === "fetch" || args[0] === "pull")) {
      const encoded = encodeURIComponent(token);
      env.GIT_CONFIG_COUNT = "2";
      env.GIT_CONFIG_KEY_0 = `url.https://x-access-token:${encoded}@github.com/.insteadOf`;
      env.GIT_CONFIG_VALUE_0 = "https://github.com/";
      env.GIT_CONFIG_KEY_1 = `url.https://oauth2:${encoded}@gitlab.com/.insteadOf`;
      env.GIT_CONFIG_VALUE_1 = "https://gitlab.com/";
    }
    const result = await this.runtime.exec(agent.id, "git", args, {
      hostCwd: cwd,
      timeoutMs: 120000,
      env,
    });
    if (process.env.LOG_GIT === "1") console.log(redactGitArgs(args).join(" "));
    if ((args[0] === "clone" || args[0] === "push" || args[0] === "fetch" || args[0] === "pull" || args[0] === "checkout" || args[0] === "init" || args[0] === "add" || args[0] === "stash") && result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    }
    return result;
  }
}

function filesForCheckout(checkout: Checkout, ownedFiles: string[]): string[] {
  if (!checkout.directory) return ownedFiles;
  const prefix = `${checkout.directory}/`;
  return ownedFiles
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter(Boolean);
}
