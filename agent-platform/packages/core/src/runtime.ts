import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { redact } from "./redact.js";
import { assertCommandAllowed } from "./policy.js";
import { checkoutPath, containerCloneEnv, containerWorkdir, workspaceCheckouts } from "./repositories.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeAgent {
  id: string;
  workspacePath: string;
  repositoryUrl?: string;
  repositoryName?: string;
  linkedRepositories?: string[];
}

export interface AgentRuntime {
  mode: "process" | "container";
  ensure(agent: RuntimeAgent): Promise<void>;
  exec(
    agentId: string,
    file: string,
    args: string[],
    opts: { hostCwd: string; timeoutMs: number; env?: Record<string, string>; humanMergeApproval?: boolean },
  ): Promise<CommandResult>;
  stop(agentId: string): Promise<void>;
  stats(agentId: string): Promise<{ memoryMb: number; cpuPercent: number } | null>;
}

export class ProcessRuntime implements AgentRuntime {
  readonly mode = "process" as const;
  private readonly workspaces = new Map<string, string>();

  async ensure(agent: RuntimeAgent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: true });
    for (const checkout of workspaceCheckouts(agentRefs(agent))) {
      if (checkout.directory) await mkdir(checkoutPath(agent.workspacePath, checkout.directory), { recursive: true });
    }
    this.workspaces.set(agent.id, agent.workspacePath);
  }

  async exec(agentId: string, file: string, args: string[], opts: { hostCwd: string; timeoutMs: number; env?: Record<string, string>; humanMergeApproval?: boolean }): Promise<CommandResult> {
    const workspace = this.workspaces.get(agentId) ?? opts.hostCwd;
    if (opts.hostCwd !== workspace && !opts.hostCwd.startsWith(workspace)) {
      return { code: 126, stdout: "", stderr: "command cwd is outside the agent workspace" };
    }
    assertCommandAllowed([file, ...args], workspace, { humanMergeApproval: opts.humanMergeApproval });
    return runProcess(file, args, {
      cwd: opts.hostCwd,
      timeoutMs: opts.timeoutMs,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: "C.UTF-8",
        ...opts.env,
      },
    });
  }

  async stop(agentId: string): Promise<void> {
    this.workspaces.delete(agentId);
  }

  async stats(): Promise<{ memoryMb: number; cpuPercent: number } | null> {
    const memory = process.memoryUsage().rss / (1024 * 1024);
    return { memoryMb: Math.round(memory), cpuPercent: 0 };
  }
}

export class DockerRuntime implements AgentRuntime {
  readonly mode = "container" as const;
  private readonly workspaces = new Map<string, string>();

  constructor(
    private readonly options: {
      image: string;
      network: string;
      memory: string;
      cpus: string;
      dockerBin?: string;
    },
  ) {}

  private name(agentId: string): string {
    return `agent-platform-${agentId.slice(0, 12)}`;
  }

  private docker(args: string[], timeoutMs = 30000): Promise<CommandResult> {
    return runProcess(this.options.dockerBin ?? "docker", args, {
      cwd: process.cwd(),
      timeoutMs,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8" },
    });
  }

  async ensure(agent: RuntimeAgent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: true });
    const checkouts = workspaceCheckouts(agentRefs(agent));
    for (const checkout of checkouts) {
      if (checkout.directory) await mkdir(checkoutPath(agent.workspacePath, checkout.directory), { recursive: true });
    }
    this.workspaces.set(agent.id, agent.workspacePath);
    const name = this.name(agent.id);
    const inspect = await this.docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (inspect.code === 0 && inspect.stdout.trim() === "true") return;
    if (inspect.code === 0) await this.docker(["rm", "-f", name]);
    const envArgs = Object.entries(containerCloneEnv(checkouts)).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const created = await this.docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "agent-platform=1",
      "--memory",
      this.options.memory,
      "--cpus",
      this.options.cpus,
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges:true",
      "--network",
      this.options.network,
      "-v",
      `${agent.workspacePath}:/app/workspace`,
      "-w",
      "/app/workspace",
      ...envArgs,
      this.options.image,
    ]);
    if (created.code !== 0) {
      throw new Error(`failed to start agent container: ${redact(created.stderr)}`);
    }
  }

  async exec(agentId: string, file: string, args: string[], opts: { hostCwd: string; timeoutMs: number; env?: Record<string, string>; humanMergeApproval?: boolean }): Promise<CommandResult> {
    const workspace = this.workspaces.get(agentId) ?? opts.hostCwd;
    assertCommandAllowed([file, ...args], workspace, { humanMergeApproval: opts.humanMergeApproval });
    const workdir = containerWorkdir(workspace, opts.hostCwd);
    if (!workdir) return { code: 126, stdout: "", stderr: "command cwd is outside the agent workspace" };
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const result = await this.docker(
      ["exec", ...envArgs, "-w", workdir, this.name(agentId), file, ...args],
      opts.timeoutMs + 1000,
    );
    return { ...result, stderr: redact(result.stderr), stdout: redact(result.stdout) };
  }

  async stop(agentId: string): Promise<void> {
    await this.docker(["rm", "-f", this.name(agentId)]);
  }

  async stats(agentId: string): Promise<{ memoryMb: number; cpuPercent: number } | null> {
    const result = await this.docker(["stats", "--no-stream", "--format", "{{.MemUsage}} {{.CPUPerc}}", this.name(agentId)]);
    if (result.code !== 0) return null;
    const [mem, cpu] = result.stdout.trim().split(/\s+/);
    const memoryMb = Number.parseFloat(mem ?? "0");
    const cpuPercent = Number.parseFloat((cpu ?? "0").replace("%", ""));
    return { memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0, cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0 };
  }
}

function agentRefs(agent: RuntimeAgent): { repositoryName: string; repositoryUrl: string; linkedRepositories: string[] } {
  return {
    repositoryName: agent.repositoryName ?? "",
    repositoryUrl: agent.repositoryUrl ?? "",
    linkedRepositories: agent.linkedRepositories ?? [],
  };
}

function runProcess(file: string, args: string[], opts: { cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-20000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-20000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
