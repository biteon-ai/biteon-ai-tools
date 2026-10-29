"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Icon } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Chip, StatusBadge } from "../../components/ui";

interface Agent { id: string; name: string; status: string; repositoryName: string; linkedRepositories?: string[]; provider: string; executorKind: string }

export default function AgentsPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    void api<Agent[]>("/api/agents").then(setAgents).catch((err: Error) => toast(err.message, "error"));
  }, [toast]);

  async function act(agent: Agent, action: "start" | "pause" | "resume") {
    try {
      const next = await api<Agent>(`/api/agents/${agent.id}/${action}`, { method: "POST" });
      setAgents((rows) => rows.map((row) => row.id === agent.id ? { ...row, status: next.status } : row));
      toast(`${agent.name} is ${next.status}`, next.status === "paused" || next.status === "stopped" ? "warning" : "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-slate-400">One agent for each repository.</p>
        </div>
        <Link href="/agents/new" className="btn">New agent</Link>
      </div>
      {agents.length === 0 ? <p className="text-sm text-slate-400">No agents yet.</p> : (
        <div className="grid gap-3">
          {agents.map((agent) => (
            <article key={agent.id} className="card p-4 transition hover:border-slate-700">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/agents/${agent.id}`} className="font-medium transition hover:text-sky-300">{agent.name}</Link>
                    <StatusBadge status={agent.status} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Chip>{agent.repositoryName || "No repository"}</Chip>
                    {(agent.linkedRepositories ?? []).length > 0 ? <Chip>{agent.linkedRepositories?.length} linked</Chip> : null}
                    <Chip>{agent.provider}</Chip>
                    <Chip>{agent.executorKind}</Chip>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-ghost" aria-label={`Start ${agent.name}`} disabled={agent.status === "running"} onClick={() => void act(agent, agent.status === "paused" ? "resume" : "start")}>
                    <Icon name="play" /> Play
                  </button>
                  <button type="button" className="btn-ghost" aria-label={`Pause ${agent.name}`} disabled={agent.status !== "running"} onClick={() => void act(agent, "pause")}>
                    <Icon name="pause" /> Pause
                  </button>
                  <Link href={`/agents/${agent.id}#logs`} className="btn-ghost"><Icon name="logs" /> Logs</Link>
                  <Link href={`/agents/${agent.id}`} className="btn-ghost"><Icon name="edit" /> Edit</Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
