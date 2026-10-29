"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { useToast } from "../../../components/Toast";
import { Icon } from "../../../components/Icons";
import { Chip, StatusBadge } from "../../../components/ui";

interface AgentRecord {
  id: string;
  name: string;
  status: string;
  description: string;
  repositoryName: string;
  repositoryUrl?: string;
  linkedRepositories?: string[];
  defaultBranch?: string;
  provider?: string;
  boardId?: string;
  boardName?: string;
  executorKind: string;
  dailyCapacityHours?: number;
  allowOverCapacity?: boolean;
  telegramChatId?: string;
  workspacePath: string;
  credential?: { configured: boolean; hint: string };
  repositoryCredential?: { configured: boolean; hint: string };
}

interface GithubRepoOption {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
}
interface WorkflowRecord {
  columns: { backlog: string; planning: string; todo: string; doing: string; review: string; done: string };
  selection: { priorityLabels: string[]; blockedLabels: string[]; maxTasksPerDay: number };
}
interface WorkflowForm {
  columns: WorkflowRecord["columns"];
  maxTasksPerDay: number;
  priorityLabels: string;
  blockedLabels: string;
}
interface Detail {
  agent: AgentRecord;
  workflow: WorkflowRecord | null;
  tasks: { id: string; externalId: string; title: string; description?: string; acceptanceCriteria?: string; estimateHours?: number | null; updatedAt?: string; stage: string; prUrl: string; boardPosition?: number; branchName?: string; checksPassed?: boolean; exceptionNote?: string; blockedReason: string }[];
  events: { id: string; message: string; createdAt: string }[];
  memories: { id: string; kind: string; title: string; body: string; revision: number }[];
  runs: { id: string; taskId?: string; status: string; startedAt?: string; summary: string; error?: string; costClass: string }[];
}

const CONFIG_COLUMNS = [
  { stage: "backlog", label: "Backlog" },
  { stage: "planning", label: "Planning" },
  { stage: "todo", label: "To Do" },
  { stage: "doing", label: "Doing" },
  { stage: "review", label: "Review" },
  { stage: "done", label: "Done" },
] as const;

function labelsToText(labels: string[] | undefined): string {
  return (labels ?? []).join(", ");
}

function textToLabels(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const BOARD_COLUMNS = [
  { stage: "backlog", label: "Backlog" },
  { stage: "todo", label: "To Do" },
  { stage: "doing", label: "Doing" },
] as const;

function boardRank(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function byColumnOrder<T extends { boardPosition?: number; title: string }>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => boardRank(left.boardPosition) - boardRank(right.boardPosition) || left.title.localeCompare(right.title));
}

const TICKET_STAGES = ["backlog", "todo", "doing", "planning", "review", "blocked", "failed", "done"];

function orderedTicketRows<T extends { stage: string; boardPosition?: number; title: string }>(rows: T[]): T[] {
  const stageIndex = (stage: string) => {
    const index = TICKET_STAGES.indexOf(stage);
    return index < 0 ? TICKET_STAGES.length : index;
  };
  return [...rows].sort((left, right) => stageIndex(left.stage) - stageIndex(right.stage) || boardRank(left.boardPosition) - boardRank(right.boardPosition) || left.title.localeCompare(right.title));
}

function taskColumns(tasks: Detail["tasks"]) {
  const known = new Set<string>(BOARD_COLUMNS.map((column) => column.stage));
  const extras = [...new Set(tasks.map((task) => task.stage).filter((stage) => !known.has(stage) && (stage === "blocked" || stage === "failed")))]
    .map((stage) => ({ stage, label: stage === "blocked" ? "Blocked" : "Failed" }));
  return [...BOARD_COLUMNS, ...extras].map((column) => ({ ...column, tasks: byColumnOrder(tasks.filter((task) => task.stage === column.stage)) }));
}

function estimateHours(task: Pick<Detail["tasks"][number], "estimateHours" | "description" | "acceptanceCriteria">): number {
  if (task.estimateHours && task.estimateHours > 0) return task.estimateHours;
  const words = `${task.description ?? ""} ${task.acceptanceCriteria ?? ""}`.trim().split(/\s+/).filter(Boolean).length;
  if (words > 400) return 8;
  if (words > 150) return 4;
  return 2;
}

function doingClock(startedAt: string, hours: number, now: number): { percent: number; elapsedMs: number; estimateMs: number; remainingMs: number } {
  const estimateMs = Math.max(hours, 0.25) * 3_600_000;
  const started = Date.parse(startedAt);
  const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now));
  const ratio = elapsedMs / estimateMs;
  const percent = ratio <= 0.95 ? Math.round(ratio * 100) : Math.min(99, Math.round(95 + 4 * (1 - Math.exp(-(ratio - 0.95) * 2))));
  return { percent, elapsedMs, estimateMs, remainingMs: Math.max(0, estimateMs - elapsedMs) };
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

function doingStartedAt(task: Detail["tasks"][number], runs: Detail["runs"]): string {
  const related = runs.filter((run) => run.taskId === task.id && run.startedAt);
  const running = related.filter((run) => run.status === "running");
  const pool = running.length > 0 ? running : related;
  if (pool.length === 0) return task.updatedAt ?? new Date().toISOString();
  return [...pool].sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))[0]!.startedAt!;
}

function DoingMeter({ task, runs }: { task: Detail["tasks"][number]; runs: Detail["runs"] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = doingClock(doingStartedAt(task, runs), estimateHours(task), now);
  const left = clock.remainingMs > 0 ? `about ${formatDuration(clock.remainingMs)} left` : `past the ${formatDuration(clock.estimateMs)} estimate`;
  return (
    <div className="mt-3">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={clock.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${clock.percent}% of 100%`}>
        <div className="progress-live h-full rounded-full" style={{ width: `${Math.max(clock.percent, 4)}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-400">{clock.percent}% of 100% · {formatDuration(clock.elapsedMs)} in · {left}</p>
    </div>
  );
}

function securityStatus(task: Detail["tasks"][number], runs: Detail["runs"]): "Passed" | "Not passed" {
  const related = runs.filter((run) => run.taskId === task.id);
  const blocked = related.some((run) => /secret|security|injection/i.test(`${run.error ?? ""} ${run.summary}`));
  if (blocked) return "Not passed";
  return task.checksPassed ? "Passed" : "Not passed";
}

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const toast = useToast();
  const router = useRouter();
  const [id, setId] = useState("");
  const [data, setData] = useState<Detail | null>(null);
  const [memory, setMemory] = useState({ title: "", body: "", kind: "decision" });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState("");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [tickets, setTickets] = useState<{ externalId: string; title: string; stage: string; boardPosition?: number }[] | null>(null);
  const [ticketNote, setTicketNote] = useState<string | null>(null);
  const [shiftText, setShiftText] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ text: string; reply: string } | null>(null);
  const [config, setConfig] = useState({ name: "", description: "", provider: "none", boardName: "", boardId: "", repositoryUrl: "", repositoryName: "", linkedRepositories: [] as string[], defaultBranch: "develop", dailyCapacityHours: 8, allowOverCapacity: false, executorKind: "fake", telegramChatId: "", boardKey: "", boardToken: "", repositoryToken: "" });
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowForm | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [githubAccount, setGithubAccount] = useState<{ login: string; name: string | null } | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepoOption[]>([]);
  const [showMemoryHelp, setShowMemoryHelp] = useState(false);
  const [logDate, setLogDate] = useState("");
  const [logLimit, setLogLimit] = useState(5);
  const [openLogIds, setOpenLogIds] = useState<Record<string, boolean>>({});
  const [showRuns, setShowRuns] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => { void params.then((value) => setId(value.id)); }, [params]);
  useEffect(() => {
    if (!id) return;
    void api<Detail>(`/api/agents/${id}`).then((detail) => {
      setData(detail);
      const agent = detail.agent;
      setConfig({
        name: agent.name,
        description: agent.description ?? "",
        provider: agent.provider ?? "none",
        boardName: agent.boardName ?? "",
        boardId: agent.boardId ?? "",
        repositoryUrl: agent.repositoryUrl ?? "",
        repositoryName: agent.repositoryName ?? "",
        linkedRepositories: agent.linkedRepositories ?? [],
        defaultBranch: agent.defaultBranch ?? "develop",
        dailyCapacityHours: agent.dailyCapacityHours ?? 8,
        allowOverCapacity: agent.allowOverCapacity ?? false,
        executorKind: agent.executorKind,
        telegramChatId: agent.telegramChatId ?? "",
        boardKey: "",
        boardToken: "",
        repositoryToken: "",
      });
      setGithubAccount(null);
      setGithubRepos([]);
      setWorkflowConfig(detail.workflow ? {
        columns: detail.workflow.columns,
        maxTasksPerDay: detail.workflow.selection.maxTasksPerDay,
        priorityLabels: labelsToText(detail.workflow.selection.priorityLabels),
        blockedLabels: labelsToText(detail.workflow.selection.blockedLabels),
      } : null);
    }).catch((err: Error) => toast(err.message, "error"));
  }, [id, toast]);
  useEffect(() => {
    if (!id) return;
    const timer = window.setInterval(() => {
      void api<Detail>(`/api/agents/${id}`).then((detail) => {
        const rows = orderedTicketRows(detail.tasks.map((task) => ({ externalId: task.externalId, title: task.title, stage: task.stage, boardPosition: task.boardPosition })));
        setData((current) => current ? { ...current, tasks: detail.tasks, events: detail.events, runs: detail.runs } : detail);
        setTickets((current) => current === null ? current : rows);
      }).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [id]);

  async function refreshBoard() {
    if (!id || pending) return;
    setPending("board");
    try {
      const result = await api<{ tasks: Detail["tasks"]; boardError: string | null }>(`/api/boards/${id}/sync`, { method: "POST" });
      const rows = orderedTicketRows(result.tasks.map((task) => ({ externalId: task.externalId, title: task.title, stage: task.stage, boardPosition: task.boardPosition })));
      setData((current) => current ? { ...current, tasks: result.tasks } : current);
      setTickets(rows);
      setTicketNote(result.boardError);
      toast(result.boardError ?? `Synced ${rows.length} ticket${rows.length === 1 ? "" : "s"} from Trello`, result.boardError ? "warning" : "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not refresh the board", "error");
    } finally {
      setPending("");
    }
  }

  async function action(name: string) {
    try {
      await api(`/api/agents/${id}/${name}`, { method: "POST" });
      const next = await api<Detail>(`/api/agents/${id}`);
      setData(next);
      const tone = name === "pause" || name === "stop" ? "warning" : "success";
      toast(`${next.agent.name} ${name} completed`, tone);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    }
  }

  async function removeMemory(memoryId: string, title: string) {
    try {
      await api(`/api/agents/${id}/memories/${memoryId}`, { method: "DELETE" });
      setData(await api<Detail>(`/api/agents/${id}`));
      toast(`${title} removed`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove memory", "error");
    }
  }

  async function addMemory(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/agents/${id}/memories`, { method: "POST", body: JSON.stringify(memory) });
      setMemory({ title: "", body: "", kind: "decision" });
      setData(await api<Detail>(`/api/agents/${id}`));
      toast("Memory saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save memory", "error");
    }
  }

  async function sendCommand(text: string, slot: "status" | "list" | "shift" | "custom") {
    const trimmed = text.trim();
    if (!trimmed || !id || pending) return;
    setPending(slot);
    if (slot === "custom") setMessage("");
    try {
      const result = await api<{ reply: string; boardError: string | null; tasks: { externalId: string; title: string; stage: string; boardPosition?: number }[] }>(`/api/agents/${id}/chat`, { method: "POST", body: JSON.stringify({ message: trimmed }) });
      const rows = orderedTicketRows(result.tasks.map((task) => ({ externalId: task.externalId, title: task.title, stage: task.stage, boardPosition: task.boardPosition })));
      if (slot === "status") setStatusText(result.reply);
      if (slot === "list") {
        setTickets(rows);
        setTicketNote(rows.length === 0 ? result.reply : result.boardError);
      }
      if (slot === "shift") setShiftText(result.reply);
      if (slot === "custom") setCustom((current) => current?.text === trimmed && current.reply === result.reply ? current : { text: trimmed, reply: result.reply });
      setData(await api<Detail>(`/api/agents/${id}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Command failed", "error");
    } finally {
      setPending("");
    }
  }

  async function connectGithub() {
    const token = config.repositoryToken.trim();
    if (!token) {
      toast("Enter a GitHub personal access token to connect the account", "warning");
      return;
    }
    setConnectingGithub(true);
    try {
      const result = await api<{ account: { login: string; name: string | null }; repositories: GithubRepoOption[] }>("/api/integrations/github/account", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setGithubAccount(result.account);
      setGithubRepos(result.repositories);
      if (!config.repositoryName && result.repositories[0]) {
        const first = result.repositories[0];
        setConfig((current) => ({
          ...current,
          repositoryName: first.fullName,
          repositoryUrl: first.htmlUrl,
          defaultBranch: current.defaultBranch || first.defaultBranch,
        }));
      }
      toast(`Connected GitHub account @${result.account.login}`, "success");
    } catch (err) {
      setGithubAccount(null);
      setGithubRepos([]);
      toast(err instanceof Error ? err.message : "Could not connect the GitHub account", "error");
    } finally {
      setConnectingGithub(false);
    }
  }

  function selectPrimaryRepository(fullName: string) {
    const selected = githubRepos.find((item) => item.fullName === fullName);
    setConfig((current) => ({
      ...current,
      repositoryName: fullName,
      repositoryUrl: selected?.htmlUrl ?? current.repositoryUrl,
      defaultBranch: selected?.defaultBranch || current.defaultBranch,
      linkedRepositories: current.linkedRepositories.filter((item) => item.trim().toLowerCase() !== fullName.toLowerCase()),
    }));
  }

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (!config.repositoryName.trim() && !config.repositoryUrl.trim()) {
      toast("A primary repository name or URL is required", "warning");
      return;
    }
    if (!config.repositoryToken.trim() && !data?.agent.repositoryCredential?.configured) {
      toast("Connect and authenticate a GitHub account for the repository", "warning");
      return;
    }
    setSavingConfig(true);
    try {
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          provider: config.provider,
          boardName: config.boardName,
          boardId: config.boardId,
          name: config.name,
          description: config.description,
          repositoryUrl: config.repositoryUrl,
          repositoryName: config.repositoryName,
          linkedRepositories: config.linkedRepositories.map((item) => item.trim()).filter(Boolean),
          defaultBranch: config.defaultBranch,
          dailyCapacityHours: Number(config.dailyCapacityHours),
          allowOverCapacity: config.allowOverCapacity,
          executorKind: config.executorKind,
          telegramChatId: config.telegramChatId,
          boardKey: config.boardKey || undefined,
          boardToken: config.boardToken || undefined,
          repositoryToken: config.repositoryToken || undefined,
        }),
      });
      if (workflowConfig) {
        await api(`/api/agents/${id}/workflow`, {
          method: "PUT",
          body: JSON.stringify({
            columns: workflowConfig.columns,
            selection: {
              maxTasksPerDay: workflowConfig.maxTasksPerDay,
              priorityLabels: textToLabels(workflowConfig.priorityLabels),
              blockedLabels: textToLabels(workflowConfig.blockedLabels),
            },
          }),
        });
      }
      const next = await api<Detail>(`/api/agents/${id}`);
      setData(next);
      setConfig((current) => ({
        ...current,
        name: next.agent.name,
        description: next.agent.description ?? "",
        linkedRepositories: next.agent.linkedRepositories ?? [],
        boardKey: "",
        boardToken: "",
        repositoryToken: "",
      }));
      toast("Agent configuration saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the configuration", "error");
    } finally {
      setSavingConfig(false);
    }
  }

  async function decideTask(task: Detail["tasks"][number], decision: "approve" | "reject") {
    setPending(decision);
    try {
      const result = await api<{ stage: string; mergedInto: string | null }>(`/api/tasks/${task.id}/${decision}`, {
        method: "POST",
        body: JSON.stringify({ comment: decision === "approve" ? "Approved and merged from the board" : "Request re-work" }),
      });
      setData(await api<Detail>(`/api/agents/${id}`));
      setSelectedId(null);
      toast(
        decision === "approve"
          ? result.mergedInto ? `${task.title} approved and merged into ${result.mergedInto}` : `${task.title} approved and moved to Done`
          : `${task.title} sent back for re-work`,
        decision === "approve" ? "success" : "warning",
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update the task", "error");
    } finally {
      setPending("");
    }
  }

  async function remove() {
    if (!window.confirm("Remove this agent? Its workspace files stay on disk.")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      toast("Agent removed", "success");
      router.push("/agents");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove the agent", "error");
    }
  }

  if (!data) return <p className="text-sm text-slate-400">Loading agent…</p>;
  const selected = data.tasks.find((task) => task.id === selectedId) ?? null;
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{data.agent.name}</h1>
          <StatusBadge status={data.agent.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip>{data.agent.repositoryName || "No repository"}</Chip>
          {(data.agent.linkedRepositories ?? []).map((repository) => <Chip key={repository}>{repository}</Chip>)}
          <Chip>{data.agent.executorKind}</Chip>
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        {["start", "pause", "resume", "restart", "stop", "tick", "sync"].map((name) => (
          <button key={name} className="btn-ghost capitalize" disabled={pending !== ""} onClick={() => void (name === "sync" ? refreshBoard() : action(name))}>{pending === "board" && name === "sync" ? "Syncing…" : name}</button>
        ))}
        <button className="btn-ghost text-rose-300" onClick={() => void remove()}>Remove</button>
      </div>
      <section className="card p-4">
        <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={showConfig} aria-controls="agent-configuration" onClick={() => setShowConfig((open) => !open)}>
          <span className="flex items-center gap-2 font-medium"><Icon name="settings" />Configuration</span>
          <Icon name="chevron" className={`h-4 w-4 text-slate-400 transition ${showConfig ? "rotate-180" : ""}`} />
        </button>
      {showConfig ? (
      <form id="agent-configuration" onSubmit={saveConfig} className="mt-4 space-y-4">
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <header className="space-y-1 border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">1. Agent</h3>
            <p className="text-sm text-slate-400">Name, summary, and how this agent runs work.</p>
          </header>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm text-slate-300">Name
              <input className="input mt-1" aria-label="Name" value={config.name} onChange={(event) => setConfig({ ...config, name: event.target.value })} />
            </label>
            <label className="block text-sm text-slate-300">Executor
              <select className="input mt-1" aria-label="Executor" value={config.executorKind} onChange={(event) => setConfig({ ...config, executorKind: event.target.value })}>
                <option value="fake">Fake (no model calls)</option>
                <option value="llm">Model router</option>
                <option value="cursor">Cursor</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="block text-sm text-slate-300 md:col-span-2">Description
              <input className="input mt-1" aria-label="Description" value={config.description} onChange={(event) => setConfig({ ...config, description: event.target.value })} placeholder="Optional short summary for this agent" />
            </label>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <header className="space-y-1 border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">2. Board</h3>
            <p className="text-sm text-slate-400">Connect the ticket board this agent reads and updates.</p>
          </header>
          <p className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-400">
            {data.agent.credential?.configured
              ? `Board credential saved ${data.agent.credential.hint}. Leave the key and token blank to keep them.`
              : "No board credential is saved yet."}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm text-slate-300">Provider
              <select className="input mt-1" aria-label="Provider" value={config.provider} onChange={(event) => setConfig({ ...config, provider: event.target.value })}>
                <option value="none">None</option>
                <option value="trello">Trello</option>
                <option value="github_projects">GitHub Projects</option>
              </select>
            </label>
            <label className="block text-sm text-slate-300">Board name
              <input className="input mt-1" aria-label="Board name" value={config.boardName} onChange={(event) => setConfig({ ...config, boardName: event.target.value })} />
            </label>
            <label className="block text-sm text-slate-300 md:col-span-2">Board id
              <input className="input mt-1" aria-label="Board id" value={config.boardId} onChange={(event) => setConfig({ ...config, boardId: event.target.value })} />
            </label>
            {config.provider === "trello" ? (
              <>
                <label className="block text-sm text-slate-300">Trello API key
                  <input className="input mt-1" aria-label="Trello API key" autoComplete="off" spellCheck={false} placeholder="Leave blank to keep the saved key" value={config.boardKey} onChange={(event) => setConfig({ ...config, boardKey: event.target.value })} />
                </label>
                <label className="block text-sm text-slate-300">Trello token
                  <input className="input mt-1" aria-label="Trello token" autoComplete="off" spellCheck={false} placeholder="Leave blank to keep the saved token" value={config.boardToken} onChange={(event) => setConfig({ ...config, boardToken: event.target.value })} />
                </label>
              </>
            ) : null}
            {config.provider === "github_projects" ? (
              <label className="block text-sm text-slate-300 md:col-span-2">GitHub Projects token
                <input className="input mt-1" aria-label="GitHub Projects token" autoComplete="off" spellCheck={false} placeholder="Leave blank to keep the saved token" value={config.boardToken} onChange={(event) => setConfig({ ...config, boardToken: event.target.value })} />
              </label>
            ) : null}
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-100">3. GitHub repository</h3>
              <p className="text-sm text-slate-400">Required. Authenticate a GitHub account, then choose the primary and linked repositories.</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${data.agent.repositoryCredential?.configured || githubAccount ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
              {githubAccount ? `Connected @${githubAccount.login}` : data.agent.repositoryCredential?.configured ? `Linked ${data.agent.repositoryCredential.hint}` : "Not connected"}
            </span>
          </header>

          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div>
              <h4 className="text-sm font-medium text-slate-200">Connect account</h4>
              <p className="mt-1 text-xs text-slate-500">
                {data.agent.repositoryCredential?.configured
                  ? "A GitHub token is already saved. Leave this blank to keep it, or paste a new token and reconnect."
                  : "Paste a personal access token, then connect so the agent can clone, push, and open pull requests."}
              </p>
            </div>
            <label className="block text-sm text-slate-300">GitHub personal access token
              <input className="input mt-1" aria-label="GitHub personal access token" autoComplete="off" spellCheck={false} required={!data.agent.repositoryCredential?.configured} placeholder={data.agent.repositoryCredential?.configured ? "Leave blank to keep the saved token" : "ghp_… or github_pat_…"} value={config.repositoryToken} onChange={(event) => setConfig({ ...config, repositoryToken: event.target.value })} />
            </label>
            <button type="button" className="btn" disabled={connectingGithub || !config.repositoryToken.trim()} onClick={() => void connectGithub()}>{connectingGithub ? "Connecting…" : "Connect GitHub account"}</button>
            {githubAccount ? <p className="text-sm text-emerald-300">Signed in as @{githubAccount.login}{githubAccount.name ? ` · ${githubAccount.name}` : ""}</p> : null}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div>
              <h4 className="text-sm font-medium text-slate-200">Primary repository</h4>
              <p className="mt-1 text-xs text-slate-500">The main repo this agent works in. Pick one from the connected account or enter it manually.</p>
            </div>
            {githubRepos.length > 0 ? (
              <label className="block text-sm text-slate-300">Choose from connected account
                <select className="input mt-1" aria-label="Choose a repository from this account" value={config.repositoryName} onChange={(event) => selectPrimaryRepository(event.target.value)}>
                  <option value="">Select a repository</option>
                  {githubRepos.map((repository) => <option key={repository.fullName} value={repository.fullName}>{repository.fullName}</option>)}
                </select>
              </label>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-sm text-slate-300">Repository URL
                <input className="input mt-1" aria-label="Repository URL" required={!config.repositoryName.trim()} value={config.repositoryUrl} onChange={(event) => setConfig({ ...config, repositoryUrl: event.target.value })} placeholder="https://github.com/owner/name" />
              </label>
              <label className="block text-sm text-slate-300">Repository
                <input className="input mt-1" aria-label="Repository" required={!config.repositoryUrl.trim()} value={config.repositoryName} onChange={(event) => setConfig({ ...config, repositoryName: event.target.value })} placeholder="owner/name" />
              </label>
              <label className="block text-sm text-slate-300">Default branch
                <input className="input mt-1" aria-label="Default branch" value={config.defaultBranch} onChange={(event) => setConfig({ ...config, defaultBranch: event.target.value })} />
              </label>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div>
              <h4 className="text-sm font-medium text-slate-200">Linked repositories</h4>
              <p className="mt-1 text-xs text-slate-500">Optional secondary repos from the same GitHub account that this agent may edit with the same credentials.</p>
            </div>
            {config.linkedRepositories.length === 0 ? <p className="text-sm text-slate-500">No linked repositories yet.</p> : null}
            {config.linkedRepositories.map((repository, index) => (
              <div key={index} className="flex gap-2">
                {githubRepos.length > 0 ? (
                  <select className="input" aria-label={`Linked repository ${index + 1}`} value={repository} onChange={(event) => setConfig({ ...config, linkedRepositories: config.linkedRepositories.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })}>
                    <option value="">Select a repository</option>
                    {githubRepos.filter((item) => item.fullName === repository || item.fullName.toLowerCase() !== config.repositoryName.trim().toLowerCase()).map((item) => (
                      <option key={item.fullName} value={item.fullName}>{item.fullName}</option>
                    ))}
                  </select>
                ) : (
                  <input className="input" aria-label={`Linked repository ${index + 1}`} value={repository} placeholder="owner/name" onChange={(event) => setConfig({ ...config, linkedRepositories: config.linkedRepositories.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} />
                )}
                <button type="button" className="btn-ghost" onClick={() => setConfig({ ...config, linkedRepositories: config.linkedRepositories.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn-ghost" onClick={() => setConfig({ ...config, linkedRepositories: [...config.linkedRepositories, ""] })}>Add repository</button>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <header className="space-y-1 border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">4. Capacity & alerts</h3>
            <p className="text-sm text-slate-400">Daily workload limits and where alerts are sent.</p>
          </header>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm text-slate-300">Daily capacity hours
              <input className="input mt-1" aria-label="Daily capacity hours" type="number" min={1} max={24} value={config.dailyCapacityHours} onChange={(event) => setConfig({ ...config, dailyCapacityHours: Number(event.target.value) })} />
            </label>
            <label className="flex items-center gap-2 self-end text-sm text-slate-300">
              <input type="checkbox" className="h-4 w-4 accent-sky-500" aria-label="Allow over capacity" checked={config.allowOverCapacity} onChange={(event) => setConfig({ ...config, allowOverCapacity: event.target.checked })} />
              Allow over capacity
            </label>
            <label className="block text-sm text-slate-300">Telegram chat id
              <input className="input mt-1" aria-label="Telegram chat id" value={config.telegramChatId} onChange={(event) => setConfig({ ...config, telegramChatId: event.target.value })} placeholder="Leave blank to use the platform pairing" />
            </label>
            <label className="block text-sm text-slate-300">Workspace
              <input className="input mt-1" aria-label="Workspace" value={data.agent.workspacePath} readOnly />
            </label>
          </div>
        </section>

        {workflowConfig ? (
          <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <header className="space-y-1 border-b border-slate-800 pb-3">
              <h3 className="text-sm font-semibold text-slate-100">5. Workflow</h3>
              <p className="text-sm text-slate-400">Map board columns and selection rules for ticket pickup.</p>
            </header>
            <div>
              <h4 className="mb-2 text-sm font-medium text-slate-200">Columns</h4>
              <div className="grid gap-3 md:grid-cols-3">
                {CONFIG_COLUMNS.map((column) => (
                  <label key={column.stage} className="block text-sm text-slate-300">{column.label}
                    <input className="input mt-1" aria-label={`${column.label} column`} value={workflowConfig.columns[column.stage] ?? ""} placeholder={column.stage === "planning" ? "None" : ""} onChange={(event) => setWorkflowConfig({ ...workflowConfig, columns: { ...workflowConfig.columns, [column.stage]: event.target.value } })} />
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-medium text-slate-200">Selection rules</h4>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="block text-sm text-slate-300">Max tasks per day
                  <input className="input mt-1" aria-label="Max tasks per day" type="number" min={0} max={1000} value={workflowConfig.maxTasksPerDay} onChange={(event) => setWorkflowConfig({ ...workflowConfig, maxTasksPerDay: Math.min(1000, Math.max(0, Math.trunc(Number(event.target.value) || 0))) })} />
                </label>
                <label className="block text-sm text-slate-300">Priority labels
                  <input className="input mt-1" aria-label="Priority labels" value={workflowConfig.priorityLabels} onChange={(event) => setWorkflowConfig({ ...workflowConfig, priorityLabels: event.target.value })} />
                </label>
                <label className="block text-sm text-slate-300">Blocked labels
                  <input className="input mt-1" aria-label="Blocked labels" value={workflowConfig.blockedLabels} onChange={(event) => setWorkflowConfig({ ...workflowConfig, blockedLabels: event.target.value })} />
                </label>
              </div>
            </div>
          </section>
        ) : null}

        <div className="flex items-center justify-end border-t border-slate-800 pt-4">
          <button className="btn" type="submit" disabled={savingConfig}>{savingConfig ? "Saving…" : "Save configuration"}</button>
        </div>
      </form>
      ) : null}
      </section>
      <section className="card p-4">
        <h2 className="mb-1 font-medium">Chat / Control</h2>
        <p className="mb-3 text-sm text-slate-400">Ask about this project: the backlog, what has been done, the status, howfar, tokens left, or any problems. You can start, pause, resume, restart, stop, tick, or sync. Say “commands” for the full list.</p>
        <div className="mb-3 flex flex-wrap gap-2">
          <button className="btn-ghost" type="button" disabled={pending !== ""} onClick={() => void sendCommand("What are you working on?", "status")}>{pending === "status" ? "Checking…" : "What are you working on?"}</button>
          <button className="btn-ghost" type="button" disabled={pending !== ""} onClick={() => void sendCommand("List tickets", "list")}>{pending === "list" ? "Loading…" : "List tickets"}</button>
          <button className="btn-ghost" type="button" disabled={pending !== "" || data.tasks.length === 0} onClick={() => void sendCommand(`Shift to ticket #${data.tasks[0]?.externalId ?? ""}`, "shift")}>{pending === "shift" ? "Shifting…" : data.tasks[0] ? `Shift to ticket #${data.tasks[0].externalId}` : "Shift to ticket #"}</button>
        </div>
        <div className="mb-3 grid gap-3 md:grid-cols-2">
          <article className="rounded-lg border border-slate-800 p-3">
            <h3 className="text-sm font-medium">Status</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{statusText ?? "Click What are you working on? to refresh this."}</p>
          </article>
          <article className="rounded-lg border border-slate-800 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Tickets</h3>
              <button type="button" className="btn-ghost" aria-label="Sync tickets" disabled={pending !== ""} onClick={() => void refreshBoard()}>{pending === "board" ? "Syncing…" : "Sync"}</button>
            </div>
            {tickets === null ? <p className="mt-1 text-sm text-slate-500">Click Sync to reload the tickets from Trello.</p> : tickets.length === 0 ? <p className="mt-1 text-sm text-slate-300">{ticketNote || "No tickets on the board."}</p> : (
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-sm">
                {tickets.map((ticket) => <li key={ticket.externalId}>#{ticket.externalId} {ticket.title} — {ticket.stage}</li>)}
              </ul>
            )}
            {tickets && tickets.length > 0 && ticketNote ? <p className="mt-2 text-xs text-amber-300">{ticketNote}</p> : null}
          </article>
        </div>
        {shiftText ? <p className="mb-3 text-sm text-emerald-300">{shiftText}</p> : null}
        {custom ? <p className="mb-3 whitespace-pre-wrap text-sm"><span className="text-sky-300">You: </span>{custom.text}<br /><span className="text-emerald-300">Agent: </span>{custom.reply}</p> : null}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void sendCommand(message, "custom"); }}>
          <input className="input" aria-label="Command" placeholder="What are you doing?" value={message} onChange={(event) => setMessage(event.target.value)} />
          <button className="btn" type="submit" disabled={pending !== ""}>Send</button>
        </form>
      </section>
      <section className="card min-w-0 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Tasks</h2>
          <button type="button" className="btn-ghost" aria-label="Sync Board" disabled={pending !== ""} onClick={() => void refreshBoard()}>{pending === "board" ? "Refreshing…" : "Refresh from Trello"}</button>
        </div>
        <div className="flex w-full min-w-0 gap-3 pb-2" style={{ overflowX: "auto" }}>
          {taskColumns(data.tasks).map((column) => (
            <section key={column.stage} className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-950/50" aria-label={column.label}>
              <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
                <h3 className="text-sm font-medium">{column.label}</h3>
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{column.tasks.length}</span>
              </header>
              {column.tasks.length === 0 ? <p className="px-3 py-3 text-xs text-slate-500">None</p> : (
                <ul className="max-h-80 space-y-2 overflow-y-auto p-2">
                  {column.tasks.map((task) => (
                    <li key={task.id}>
                      <button type="button" className="w-full rounded-lg border border-slate-800 bg-slate-900 p-3 text-left text-sm hover:border-slate-600" onClick={() => setSelectedId(task.id)}>
                        <p className="font-medium leading-5">{task.title}</p>
                        <p className="mt-1 text-xs text-slate-500">#{task.externalId}</p>
                        {column.stage === "doing" ? <DoingMeter task={task} runs={data.runs} /> : null}
                        {task.blockedReason ? <p className="mt-2 text-xs text-amber-300">{task.blockedReason}</p> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <article className="card p-4">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-medium">Project memory</h2>
            <button type="button" className="rounded-full p-1 text-slate-400 hover:text-slate-100" aria-expanded={showMemoryHelp} aria-label="What project memory is for" onClick={() => setShowMemoryHelp((open) => !open)}>
              <Icon name="info" className="h-4 w-4" />
            </button>
          </div>
          {showMemoryHelp ? <p className="mb-3 text-sm text-slate-400">Project memory keeps the decisions and conventions for this repository. The agent reads every note on each build, and writes one while it works on a ticket, so later work stays on that ticket and this project. Remove a note when it should stop guiding the agent.</p> : null}
          {data.memories.map((item) => (
            <div key={item.id} className="mb-2 flex items-start justify-between gap-3 text-sm">
              <p><span className="text-sky-300">{item.kind}</span> {item.title} (r{item.revision})</p>
              <button type="button" className="btn-ghost shrink-0 text-rose-300" aria-label={`Remove ${item.title}`} onClick={() => void removeMemory(item.id, item.title)}>Remove</button>
            </div>
          ))}
          <form onSubmit={addMemory} className="space-y-2">
            <input className="input" aria-label="Title" placeholder="Title" value={memory.title} onChange={(event) => setMemory({ ...memory, title: event.target.value })} />
            <textarea className="input" aria-label="What should the agent remember?" placeholder="What should the agent remember?" value={memory.body} onChange={(event) => setMemory({ ...memory, body: event.target.value })} />
            <button className="btn" type="submit">Save memory</button>
          </form>
        </article>
        <article id="logs" className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">Logs</h2>
            <label className="flex items-center gap-2 text-xs text-slate-400">Date
              <input className="input w-auto py-1" type="date" aria-label="Log date" value={logDate} onChange={(event) => { setLogDate(event.target.value); setLogLimit(5); }} />
            </label>
          </div>
          {(() => {
            const lines = data.events.filter((event, index, all) => event.message !== all[index - 1]?.message).filter((event) => !logDate || event.createdAt.slice(0, 10) === logDate);
            const visible = lines.slice(0, logLimit);
            if (lines.length === 0) return <p className="text-sm text-slate-400">{logDate ? "No log lines on that date." : "No log lines yet."}</p>;
            return (
              <div className="space-y-2">
                {visible.map((event) => {
                  const open = openLogIds[event.id] === true;
                  const long = event.message.length > 180;
                  return (
                    <p key={event.id} className="text-sm text-slate-300">
                      <span className="text-slate-500">{event.createdAt.slice(0, 16).replace("T", " ")}</span>
                      {" · "}
                      {open || !long ? event.message : `${event.message.slice(0, 180)}…`}
                      {long ? <button type="button" className="ml-2 text-sky-300" onClick={() => setOpenLogIds((current) => ({ ...current, [event.id]: !open }))}>{open ? "See less" : "See more"}</button> : null}
                    </p>
                  );
                })}
                {lines.length > visible.length ? <button type="button" className="btn-ghost" onClick={() => setLogLimit((count) => count + 8)}>See more ({lines.length - visible.length})</button> : null}
              </div>
            );
          })()}
          <button type="button" className="mt-4 flex items-center gap-1 text-sm font-medium" aria-expanded={showRuns} onClick={() => setShowRuns((open) => !open)}>
            <Icon name="chevron" className={`h-4 w-4 text-slate-400 transition ${showRuns ? "" : "-rotate-90"}`} />
            Runs ({data.runs.length})
          </button>
          {showRuns ? data.runs.map((run) => <p key={run.id} className="mt-2 text-sm">{run.status} · {run.costClass} · {run.summary}</p>) : null}
        </article>
      </section>
      {selected ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4" role="presentation" onClick={() => setSelectedId(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="task-detail-title" className="card max-h-[85vh] w-full max-w-lg overflow-y-auto p-5" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">{selected.stage}</p>
                <h2 id="task-detail-title" className="mt-1 text-lg font-semibold">{selected.title}</h2>
                <p className="mt-1 text-xs text-slate-500">#{selected.externalId}</p>
              </div>
              <button type="button" className="btn-ghost" onClick={() => setSelectedId(null)}>Close</button>
            </div>
            {selected.stage === "doing" ? <div className="mb-4"><DoingMeter task={selected} runs={data.runs} /></div> : null}
            {selected.description ? <p className="mb-4 whitespace-pre-wrap text-sm text-slate-300">{selected.description}</p> : null}
            {selected.blockedReason ? <p className="mb-4 text-sm text-amber-300">{selected.blockedReason}</p> : null}
            {selected.stage === "review" ? (
              <div className="space-y-3 text-sm">
                <p><span className="text-slate-400">Branch</span><br /><span className="font-medium">{selected.branchName || "Not created yet"}</span></p>
                <div>
                  <p className="text-slate-400">Pull request</p>
                  {selected.prUrl.split(/\s+/).filter(Boolean).length === 0 ? <p className="font-medium">No pull request linked</p> : selected.prUrl.split(/\s+/).filter(Boolean).map((url) => (
                    <a key={url} className="mt-1 block truncate text-sky-300" href={url} target="_blank" rel="noreferrer">{url}</a>
                  ))}
                </div>
                <p><span className="text-slate-400">Validation tests</span><br /><span className={selected.checksPassed ? "font-medium text-emerald-300" : "font-medium text-rose-300"}>{selected.checksPassed ? "Passed" : selected.exceptionNote || "Not passed"}</span></p>
                <p><span className="text-slate-400">Security checks</span><br /><span className={securityStatus(selected, data.runs) === "Passed" ? "font-medium text-emerald-300" : "font-medium text-rose-300"}>{securityStatus(selected, data.runs)}</span></p>
                <div className="grid gap-2 pt-2 sm:grid-cols-2">
                  <button type="button" className="inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50" disabled={pending !== ""} onClick={() => void decideTask(selected, "approve")}>{pending === "approve" ? "Merging…" : "Approve & Merge"}</button>
                  <button type="button" className="inline-flex items-center justify-center rounded-lg bg-rose-600 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50" disabled={pending !== ""} onClick={() => void decideTask(selected, "reject")}>{pending === "reject" ? "Sending…" : "Reject / Request Re-work"}</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
