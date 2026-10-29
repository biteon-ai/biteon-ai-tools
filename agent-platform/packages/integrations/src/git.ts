import { mkdir } from "node:fs/promises";
import type { Agent, Task } from "@agent-platform/shared";
import { assertGitAllowed, checkoutPath, redactGitArgs, workspaceCheckouts, type AgentRuntime, type Checkout } from "@agent-platform/core";
import { openLinkedChanges } from "./changes.js";

export class WorkspaceGit {
  constructor(private readonly runtime: AgentRuntime) {}

  async prepare(agent: Agent, task: Task, ownedFiles: string[], token = ""): Promise<{ branch: string; dirtyForeign: boolean }> {
    await this.runtime.ensure(agent);
    const checkouts = this.checkouts(agent);
    const branch = task.branchName || `agent/${task.externalId}`;
    let dirtyForeign = false;
    for (const checkout of checkouts) {
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      if (checkout.directory) await mkdir(cwd, { recursive: true });
      const hasGit = await this.exec(agent, ["rev-parse", "--is-inside-work-tree"], "", cwd);
      if (hasGit.code !== 0) {
        if (checkout.url) await this.exec(agent, ["clone", checkout.url, "."], token, cwd);
        else await this.exec(agent, ["init", "-b", agent.defaultBranch || "develop"], "", cwd);
      }
      await this.ensureIdentity(agent, cwd);
      await this.updateFromOrigin(agent, cwd, agent.defaultBranch || "develop", token);
      const existing = await this.exec(agent, ["rev-parse", "--verify", "--quiet", branch], "", cwd);
      if (existing.code !== 0) await this.exec(agent, ["checkout", "-b", branch], "", cwd);
      else {
        await this.exec(agent, ["checkout", branch], "", cwd);
        const remoteBranch = await this.exec(agent, ["rev-parse", "--verify", "--quiet", `origin/${branch}`], "", cwd);
        if (remoteBranch.code === 0) await this.exec(agent, ["pull", "--ff-only", "origin", branch], token, cwd);
      }
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

  async commitAndPush(agent: Agent, task: Task, ownedFiles: string[], message: string, token = ""): Promise<{ prUrl: string }> {
    if (ownedFiles.length === 0) return { prUrl: task.prUrl };
    const checkouts = this.checkouts(agent);
    const changed: Checkout[] = [];
    for (const checkout of checkouts) {
      const files = filesForCheckout(checkout, ownedFiles);
      if (files.length === 0) continue;
      const cwd = checkoutPath(agent.workspacePath, checkout.directory);
      await this.exec(agent, ["add", "--", ...files], "", cwd);
      const committed = await this.exec(agent, ["commit", "-m", message], "", cwd);
      if (committed.code !== 0 && !committed.stdout.includes("nothing to commit") && !committed.stderr.includes("nothing to commit")) {
        throw new Error("git commit failed");
      }
      const remote = await this.exec(agent, ["remote", "get-url", "origin"], "", cwd);
      if (remote.code === 0 && checkout.url.startsWith("http")) {
        await this.exec(agent, ["push", "origin", `HEAD:refs/heads/${task.branchName}`], token, cwd);
        changed.push(checkout);
      }
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
    if (token && (args[0] === "push" || args[0] === "clone" || args[0] === "fetch" || args[0] === "pull")) {
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
    if ((args[0] === "clone" || args[0] === "push" || args[0] === "fetch" || args[0] === "pull" || args[0] === "checkout" || args[0] === "init" || args[0] === "add") && result.code !== 0) {
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
