import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodeExecutor, ExecutorProgress, ExecutorResult, ExecutorRun } from "@agent-platform/shared";
import { redact } from "@agent-platform/core";

const execFileAsync = promisify(execFile);

interface CursorModule {
  Agent: {
    create(options: {
      apiKey: string;
      model: { id: string };
      local: { cwd: string; settingSources?: string[] };
    }): Promise<{
      agentId: string;
      send(prompt: string): Promise<{
        id?: string;
        supports?(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
        stream?(): AsyncGenerator<CursorStreamEvent, void>;
        wait(): Promise<{ status: string; id: string; result?: string }>;
      }>;
      [Symbol.asyncDispose](): Promise<void>;
    }>;
  };
  CursorAgentError: new (message?: string) => Error & { isRetryable?: boolean };
}

type CursorStreamEvent =
  | {
      type: "assistant";
      message: { content: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string; input?: unknown }> };
    }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; status: "running" | "completed" | "error"; args?: unknown; result?: unknown }
  | { type: "status"; status: string; message?: string }
  | { type: "task"; status?: string; text?: string }
  | { type: string; [key: string]: unknown };

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
    const beforeHeads = await snapshotHeads(input.workspaceDir);
    try {
      const agent = await sdk.Agent.create({
        apiKey: input.model.apiKey,
        model: { id: cursorModelId(input.model.modelId) },
        local: { cwd: input.workspaceDir, settingSources: [] },
      });
      try {
        const run = await agent.send(input.prompt);
        await reportProgress(input, { kind: "status", text: "Cursor agent started", status: "RUNNING" });
        await consumeStream(run, input);
        const result = await run.wait();
        if (result.status === "error") {
          return failed(input, `Cursor run ${result.id} failed`, result.id);
        }
        const ownedFiles = await collectOwnedFiles(
          input.workspaceDir,
          beforeHeads,
          input.checkpoint?.ownedFiles ?? [],
        );
        return {
          status: "succeeded",
          summary: result.result || `Cursor run ${result.id} finished`,
          tokensIn: 0,
          tokensOut: 0,
          modelId: input.model.modelId,
          costClass: "paid",
          checkpoint: { step: (input.checkpoint?.step ?? 0) + 1, note: result.id, ownedFiles },
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

async function consumeStream(
  run: {
    supports?(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
    stream?(): AsyncGenerator<CursorStreamEvent, void>;
  },
  input: ExecutorRun,
): Promise<void> {
  if (!run.stream || (run.supports && !run.supports("stream"))) return;
  const buffer = createProgressBuffer(input);
  try {
    for await (const event of run.stream()) {
      await buffer.handle(event);
    }
  } catch (error) {
    await reportProgress(input, {
      kind: "status",
      text: `Stream interrupted: ${redact(error instanceof Error ? error.message : "unknown")}`,
      status: "ERROR",
    });
  } finally {
    await buffer.flush();
  }
}

function createProgressBuffer(input: ExecutorRun) {
  let pending: ExecutorProgress | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_MS = 1500;
  const MAX_CHARS = 1200;

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending) return;
    const next = pending;
    pending = null;
    await reportProgress(input, next);
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_MS);
  }

  async function handle(event: CursorStreamEvent): Promise<void> {
    const updates = progressFromEvent(event);
    for (const update of updates) {
      if (update.kind === "thinking" || update.kind === "assistant") {
        if (pending && pending.kind === update.kind) {
          pending = { ...pending, text: trimText(`${pending.text}${pending.text ? "\n" : ""}${update.text}`, MAX_CHARS * 2) };
          if ((pending.text?.length ?? 0) >= MAX_CHARS) await flush();
          else scheduleFlush();
          continue;
        }
        await flush();
        pending = { ...update, text: trimText(update.text, MAX_CHARS * 2) };
        scheduleFlush();
        continue;
      }
      await flush();
      await reportProgress(input, update);
    }
  }

  return { handle, flush };
}

function progressFromEvent(event: CursorStreamEvent): ExecutorProgress[] {
  if (event.type === "thinking" && typeof event.text === "string" && event.text.trim()) {
    return [{ kind: "thinking", text: event.text.trim() }];
  }
  if (event.type === "assistant" && event.message?.content) {
    const updates: ExecutorProgress[] = [];
    for (const block of event.message.content) {
      if (block.type === "text" && block.text.trim()) updates.push({ kind: "assistant", text: block.text.trim() });
      if (block.type === "tool_use") updates.push({ kind: "tool", text: `Calling ${block.name}`, tool: block.name, status: "running" });
    }
    return updates;
  }
  if (event.type === "tool_call") {
    const path = toolPath(event.args) || toolPath(event.result);
    const snippet = toolSnippet(event.name, event.args, event.result);
    const detail = path || toolDetail(event.args) || toolDetail(event.result);
    const label = event.status === "running" ? "Running" : event.status === "completed" ? "Finished" : "Failed";
    return [{
      kind: "tool",
      text: detail ? `${label} ${event.name}: ${detail}` : `${label} ${event.name}`,
      tool: event.name,
      status: event.status,
      path: path || undefined,
      snippet: snippet || undefined,
    }];
  }
  if (event.type === "status") {
    return [{ kind: "status", text: event.message?.trim() || `Cursor status: ${event.status}`, status: event.status }];
  }
  if (event.type === "task" && (event.text || event.status)) {
    return [{ kind: "task", text: event.text?.trim() || `Task update: ${event.status}`, status: event.status }];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toolPath(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["path", "file", "file_path", "target_file", "filePath"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) return shortenPath(item.trim());
  }
  return "";
}

function toolDetail(args: unknown): string {
  const record = asRecord(args);
  if (!record) return "";
  for (const key of ["path", "file", "file_path", "command", "query", "pattern", "target_directory"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return trimText(shortenPath(value.trim()), 160);
  }
  try {
    return trimText(JSON.stringify(args), 160);
  } catch {
    return "";
  }
}

function toolSnippet(toolName: string, args: unknown, result: unknown): string {
  const fromArgs = extractCodeSnippet(args);
  if (fromArgs) return fromArgs;
  const fromResult = extractCodeSnippet(result);
  if (fromResult) return fromResult;
  if (/edit|write|strreplace|apply_patch|search_replace/i.test(toolName)) {
    const record = asRecord(args) ?? asRecord(result);
    if (!record) return "";
    try {
      return trimText(JSON.stringify(record, null, 2), 1200);
    } catch {
      return "";
    }
  }
  return "";
}

function extractCodeSnippet(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    if (typeof value === "string" && looksLikeCode(value)) return trimText(value.trim(), 1200);
    return "";
  }
  for (const key of ["new_string", "new_text", "contents", "content", "code", "patch", "diff", "replacement", "updated_file"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) {
      const body = item.trim();
      if (key === "diff" || key === "patch") return trimText(body, 1200);
      const old = record.old_string ?? record.old_text ?? record.oldText;
      if (typeof old === "string" && old.trim() && (key === "new_string" || key === "new_text" || key === "replacement")) {
        return trimText(formatReplaceSnippet(old.trim(), body), 1200);
      }
      return trimText(body, 1200);
    }
  }
  if (typeof record.stdout === "string" && looksLikeCode(record.stdout)) return trimText(record.stdout.trim(), 800);
  return "";
}

function formatReplaceSnippet(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n").slice(0, 8).map((line) => `- ${line}`);
  const newLines = newText.split("\n").slice(0, 16).map((line) => `+ ${line}`);
  return [...oldLines, ...newLines].join("\n");
}

function looksLikeCode(value: string): boolean {
  return /[{};=]|^\s*(def|class|function|import|export|const|let|var|async|return)\b/m.test(value) || value.includes("\n");
}

function shortenPath(value: string): string {
  const marker = "/workspaces/";
  const index = value.indexOf(marker);
  if (index >= 0) {
    const rest = value.slice(index + marker.length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  return value.replace(/^\/var\/lib\/agent-platform\/workspaces\/[^/]+\//, "");
}

function trimText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

async function reportProgress(input: ExecutorRun, update: ExecutorProgress): Promise<void> {
  if (!input.onProgress || !update.text.trim()) return;
  try {
    await input.onProgress(update);
  } catch {
    // Watching must never fail the Cursor run.
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

async function listCheckoutDirs(workspace: string): Promise<string[]> {
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
  const linked = entries
    .filter((entry) => entry.isDirectory() && (entry.name === "repo-primary" || entry.name.startsWith("repo-secondary")))
    .map((entry) => entry.name)
    .sort();
  return linked.length > 0 ? linked : [""];
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 2_000_000 });
    return String(stdout ?? "");
  } catch {
    return "";
  }
}

async function snapshotHeads(workspace: string): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  for (const dir of await listCheckoutDirs(workspace)) {
    const cwd = dir ? path.join(workspace, dir) : workspace;
    const head = (await gitStdout(cwd, ["rev-parse", "HEAD"])).trim();
    if (head) heads.set(dir, head);
  }
  return heads;
}

/** Paths Cursor changed: dirty files + commits made during the run, plus prior owned files. */
export async function collectOwnedFiles(
  workspace: string,
  beforeHeads: Map<string, string>,
  previous: string[],
): Promise<string[]> {
  const owned = new Set(previous.filter(Boolean));
  for (const dir of await listCheckoutDirs(workspace)) {
    const cwd = dir ? path.join(workspace, dir) : workspace;
    const prefix = dir ? `${dir}/` : "";
    const status = await gitStdout(cwd, ["status", "--porcelain"]);
    for (const line of status.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      const pathPart = trimmed.slice(3).trim();
      const file = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop()!.trim() : pathPart;
      if (file) owned.add(`${prefix}${file}`);
    }
    const before = beforeHeads.get(dir);
    if (before) {
      const committed = await gitStdout(cwd, ["diff", "--name-only", before, "HEAD"]);
      for (const file of committed.split("\n").map((item) => item.trim()).filter(Boolean)) {
        owned.add(`${prefix}${file}`);
      }
    }
  }
  return [...owned].sort();
}
