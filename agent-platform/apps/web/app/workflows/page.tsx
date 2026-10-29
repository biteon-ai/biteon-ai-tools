"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";

const STAGES = ["backlog", "planning", "todo", "doing", "review", "done"] as const;
const LABELS: Record<(typeof STAGES)[number], string> = {
  backlog: "Backlog",
  planning: "Planning",
  todo: "To Do",
  doing: "Doing",
  review: "Review",
  done: "Done",
};

interface Agent { id: string; name: string }
interface Workflow {
  columns: Record<string, string>;
  selection: { priorityLabels: string[]; blockedLabels: string[]; maxTasksPerDay: number };
}

export default function WorkflowsPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [boardColumns, setBoardColumns] = useState<string[]>([]);
  const [boardConnected, setBoardConnected] = useState(false);
  const [boardNote, setBoardNote] = useState("");

  useEffect(() => {
    void api<Agent[]>("/api/agents").then((rows) => {
      setAgents(rows);
      if (rows[0]) setAgentId(rows[0].id);
    }).catch((err: Error) => toast(err.message, "error"));
  }, [toast]);
  useEffect(() => {
    if (!agentId) return;
    void api<Workflow>(`/api/agents/${agentId}/workflow`).then(setWorkflow).catch((err: Error) => toast(err.message, "error"));
    void api<{ columns: string[]; connected: boolean; reason?: string }>(`/api/agents/${agentId}/board-columns`).then((result) => {
      setBoardColumns(result.columns);
      setBoardConnected(result.connected);
      setBoardNote(result.reason === "trello_key_missing"
        ? "Trello is linked, but list names need the API key and token saved together as JSON. Planning can stay None when that list does not exist."
        : "");
    }).catch((err: Error) => toast(err.message, "error"));
  }, [agentId, toast]);

  function columnChoices(stage: (typeof STAGES)[number]): string[] {
    const saved = workflow?.columns[stage] ?? "";
    const names = boardColumns.length > 0 ? boardColumns : STAGES.map((item) => LABELS[item]);
    return saved && !names.includes(saved) ? [saved, ...names] : names;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!workflow) return;
    try {
      await api(`/api/agents/${agentId}/workflow`, { method: "PUT", body: JSON.stringify(workflow) });
      toast("Workflow saved. Done still requires human approval.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the workflow", "error");
    }
  }

  if (!workflow) return <p className="text-sm text-slate-400">Select an agent to edit its column mapping.</p>;
  return (
    <form onSubmit={save} className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflow</h1>
          <p className="text-sm text-slate-400">Backlog is the starting queue. When it has work that fits the daily capacity, the agent plans it and starts it before older To Do items. Done stays behind approval.</p>
          <p className="mt-1 text-xs text-slate-500">{boardNote || (boardConnected ? "Column choices come from the connected board." : "No board is connected, so the menus use the default column names.")}</p>
        </div>
        <select className="input max-w-xs" aria-label="Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </header>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((stage, index) => (
          <div key={stage} className="flex items-stretch gap-3">
            <article className={`card min-w-44 p-3 ${stage === "done" ? "ring-1 ring-emerald-500/30" : ""}`}>
              <p className="text-xs uppercase tracking-wide text-slate-500">{index + 1}</p>
              <h2 className="mt-1 font-medium">{LABELS[stage]}</h2>
              <label className="mt-3 block text-xs text-slate-400">Board column
                <select className="input mt-1" aria-label={stage} value={workflow.columns[stage] ?? ""} onChange={(event) => setWorkflow({ ...workflow, columns: { ...workflow.columns, [stage]: event.target.value } })}>
                  {stage === "planning" ? <option value="">None</option> : null}
                  {columnChoices(stage).filter(Boolean).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                {stage === "planning" ? <span className="mt-1 block text-slate-500">Leave this as None when the board has no Planning list. Cards move from Backlog straight to To Do.</span> : null}
              </label>
            </article>
            {index < STAGES.length - 1 ? <span className="self-center text-slate-500" aria-hidden>➔</span> : null}
          </div>
        ))}
      </div>
      <div className="max-w-md space-y-3">
        <label className="block text-sm text-slate-300">Max tasks per day
          <input
            type="number"
            min={0}
            max={1000}
            className="input mt-1"
            aria-label="Max tasks per day"
            aria-describedby="max-tasks-help"
            placeholder="0"
            value={workflow.selection.maxTasksPerDay === 0 ? "" : workflow.selection.maxTasksPerDay}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const parsed = raw === "" ? 0 : Math.trunc(Number(raw));
              const maxTasksPerDay = Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : 0;
              setWorkflow({ ...workflow, selection: { ...workflow.selection, maxTasksPerDay } });
            }}
          />
          <span id="max-tasks-help" className="mt-1 block text-xs text-slate-500">Set to 0 or leave empty to automatically process all available backlog tasks without a daily limit.</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-sky-500"
            checked={workflow.selection.maxTasksPerDay === 0}
            onChange={(event) => setWorkflow({ ...workflow, selection: { ...workflow.selection, maxTasksPerDay: event.target.checked ? 0 : 5 } })}
          />
          Process All Backlog Tasks
        </label>
      </div>
      <button className="btn" type="submit">Save workflow</button>
    </form>
  );
}
