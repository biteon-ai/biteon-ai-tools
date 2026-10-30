"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatAppDateTime } from "../lib/time";
import { Icon } from "./Icons";

interface ActivityPayload {
  task: {
    id: string;
    title: string;
    stage: string;
    externalId: string;
    branchName?: string;
    blockedReason?: string;
    updatedAt?: string;
  };
  activeRun: {
    id: string;
    status: string;
    activity: string;
    modelId: string;
    summary: string;
    error?: string;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  runs: { id: string; status: string; activity: string; modelId: string; summary: string; error?: string; startedAt: string; finishedAt: string | null }[];
  events: { id: string; kind: string; message: string; metadata?: Record<string, unknown>; createdAt: string }[];
  checkpoints: { id: string; step: number; note: string; ownedFiles: string[]; createdAt: string }[];
}

function kindLabel(kind: string, metadata?: Record<string, unknown>): string {
  const progress = typeof metadata?.progressKind === "string" ? metadata.progressKind : "";
  if (progress === "thinking" || kind === "executor_thinking") return "Thinking";
  if (progress === "assistant" || kind === "executor_assistant") return "Generating";
  if (progress === "tool" || kind === "executor_tool") return "Tool";
  if (progress === "status" || kind === "executor_status") return "Status";
  if (progress === "task" || kind === "executor_task") return "Task";
  if (kind === "tick") return "Tick";
  if (kind === "notification") return "Notice";
  return kind.replace(/^executor_/, "") || "Update";
}

function kindTone(kind: string, metadata?: Record<string, unknown>): string {
  const label = kindLabel(kind, metadata);
  if (label === "Thinking") return "border-violet-500/40 bg-violet-500/10 text-violet-200";
  if (label === "Generating") return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  if (label === "Tool") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (label === "Status") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-slate-700 bg-slate-900 text-slate-300";
}

function metaString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function shortenDisplayPath(value: string): string {
  return value
    .replace(/^\/var\/lib\/agent-platform\/workspaces\/[^/]+\//, "")
    .replace(/^repo-primary\//, "core/")
    .replace(/^repo-secondary\//, "console/");
}

function CodeSnippet({ snippet, path }: { snippet: string; path?: string }) {
  const [open, setOpen] = useState(true);
  const lines = snippet.split("\n");
  const preview = lines.length > 24 ? `${lines.slice(0, 24).join("\n")}\n…` : snippet;
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-slate-700/80 bg-slate-950/70">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-2.5 py-1.5 text-[11px] text-slate-400">
        <span className="truncate font-mono">{path ? shortenDisplayPath(path) : "code preview"}</span>
        <button type="button" className="shrink-0 text-sky-300 hover:text-sky-200" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[12px] leading-5 text-slate-200 whitespace-pre">{preview}</pre>
      ) : null}
    </div>
  );
}

export function ActivityWatchModal({
  taskId,
  taskTitle,
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<ActivityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await api<ActivityPayload>(`/api/tasks/${taskId}/activity`);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        setLive(next.activeRun?.status === "running" || next.task.stage === "doing");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load activity");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [payload?.events.length]);

  const events = payload?.events ?? [];
  const active = payload?.activeRun;
  const latestRun = active ?? payload?.runs[0] ?? null;
  const historyMode = payload?.task.stage === "review" || payload?.task.stage === "blocked" || payload?.task.stage === "failed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-watch-title"
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">{historyMode ? "Activity history" : "Live activity"}</p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${live ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                {live ? "Watching" : historyMode ? "History" : "Idle"}
              </span>
            </div>
            <h2 id="activity-watch-title" className="mt-1 truncate text-lg font-semibold">{payload?.task.title ?? taskTitle}</h2>
            <p className="mt-1 text-xs text-slate-500">
              #{payload?.task.externalId ?? "…"}
              {latestRun ? ` · ${latestRun.status} · ${latestRun.activity}${latestRun.modelId ? ` · ${latestRun.modelId}` : ""}` : " · no runs yet"}
            </p>
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={onClose}>Close</button>
        </div>

        <div className="grid gap-3 border-b border-slate-800 px-5 py-3 text-xs text-slate-400 sm:grid-cols-3">
          <p><span className="text-slate-500">Stage</span><br /><span className="text-slate-200">{payload?.task.stage ?? "…"}</span></p>
          <p><span className="text-slate-500">Branch</span><br /><span className="truncate text-slate-200">{payload?.task.branchName || "Not created yet"}</span></p>
          <p><span className="text-slate-500">{latestRun?.finishedAt ? "Finished" : "Started"}</span><br /><span className="text-slate-200">{latestRun?.finishedAt || latestRun?.startedAt ? formatAppDateTime(latestRun.finishedAt || latestRun.startedAt) : "—"}</span></p>
        </div>

        {payload?.task.blockedReason ? (
          <div className="border-b border-slate-800 px-5 py-3 text-sm text-amber-300">{payload.task.blockedReason}</div>
        ) : null}

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          onScroll={(event) => {
            const node = event.currentTarget;
            stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
        >
          {error ? <p className="text-sm text-rose-300">{error}</p> : null}
          {!error && events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-400">
              <Icon name="spark" className="mx-auto mb-2 h-5 w-5 text-slate-500" />
              {historyMode
                ? "No recorded thinking, tools, or code for this ticket yet."
                : "Waiting for the agent to start thinking, calling tools, and writing code…"}
            </div>
          ) : null}
          <ol className="space-y-3">
            {events.map((event) => {
              const label = kindLabel(event.kind, event.metadata);
              const snippet = metaString(event.metadata, "snippet");
              const path = metaString(event.metadata, "path");
              return (
                <li key={event.id} className={`rounded-lg border px-3 py-2 ${kindTone(event.kind, event.metadata)}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide opacity-80">
                    <span>{label}</span>
                    <span className="text-slate-500 normal-case tracking-normal">{formatAppDateTime(event.createdAt)}</span>
                    {metaString(event.metadata, "tool") ? <span className="normal-case tracking-normal text-slate-400">{metaString(event.metadata, "tool")}</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{event.message}</p>
                  {snippet ? <CodeSnippet snippet={snippet} path={path || undefined} /> : null}
                </li>
              );
            })}
          </ol>
          <div ref={bottomRef} />
        </div>

        {payload && payload.checkpoints.length > 0 ? (
          <div className="border-t border-slate-800 px-5 py-3">
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Checkpoints</p>
            <div className="flex flex-wrap gap-2">
              {payload.checkpoints.slice(-6).map((checkpoint) => (
                <span key={checkpoint.id} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" title={checkpoint.note}>
                  Step {checkpoint.step}: {checkpoint.note.slice(0, 48)}{checkpoint.note.length > 48 ? "…" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {latestRun?.summary || latestRun?.error ? (
          <div className="border-t border-slate-800 px-5 py-3 text-sm text-slate-300">
            {latestRun.error ? <p className="text-rose-300">{latestRun.error}</p> : <p className="line-clamp-3">{latestRun.summary}</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
