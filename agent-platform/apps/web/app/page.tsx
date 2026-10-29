"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../components/Toast";

interface Dashboard {
  agents: { total: number; running: number; paused: number; stopped: number; error: number; created: number };
  tasks: { active: number; queued: number; completed: number; failed: number; blocked: number; review: number };
  recentActivity: { id: string; message: string; createdAt: string }[];
  usage: { modelId: string; costClass: string; tokens: number }[];
  alerts: { id: string; title: string; body: string; severity: string }[];
  resources: { runtimeMode?: string; rssMb?: number };
  workerSeenAt: string | null;
  exampleMasterKey: boolean;
}

export default function DashboardPage() {
  const toast = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const warned = useRef(false);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const next = await api<Dashboard>("/api/dashboard");
        if (cancel) return;
        setData(next);
        if (next.exampleMasterKey && !warned.current) {
          warned.current = true;
          toast("The master key is still the example value. Replace it before storing real credentials.", "warning");
        }
      } catch (err) {
        if (!cancel) toast(err instanceof Error ? err.message : "Dashboard failed to load", "error");
      }
    }
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => { cancel = true; clearInterval(timer); };
  }, [toast]);

  if (!data) return <p className="text-sm text-slate-400">Loading dashboard…</p>;
  const cards = [
    ["Agents", String(data.agents.total)],
    ["Running", String(data.agents.running)],
    ["Active tasks", String(data.tasks.active)],
    ["Queued", String(data.tasks.queued)],
    ["Review", String(data.tasks.review)],
    ["Done", String(data.tasks.completed)],
    ["Blocked", String(data.tasks.blocked)],
    ["Failed", String(data.tasks.failed)],
  ];
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-400">Agents, task flow, and the worker heartbeat.</p>
      </header>
      {data.exampleMasterKey ? <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">The master key is still the example value. Replace it before storing real credentials.</p> : null}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <article key={label} className="card p-4 transition hover:border-slate-700">
            <p className="text-sm text-slate-400">{label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
          </article>
        ))}
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <article className="card p-4">
          <h2 className="mb-3 font-medium">Alerts</h2>
          {data.alerts.length === 0 ? <p className="text-sm text-slate-400">No alerts.</p> : data.alerts.map((alert) => (
            <p key={alert.id} className="mb-2 text-sm"><span className="text-amber-300">{alert.severity}</span> {alert.title}</p>
          ))}
        </article>
        <article className="card p-4">
          <h2 className="mb-3 font-medium">Usage and resources</h2>
          <p className="text-sm text-slate-300">Runtime {String(data.resources.runtimeMode ?? "unknown")} · worker RSS {String(data.resources.rssMb ?? 0)} MB</p>
          <p className="text-sm text-slate-400">Worker heartbeat {data.workerSeenAt ?? "not seen"}</p>
          {data.usage.map((item) => (
            <p key={item.modelId} className="mt-2 text-sm">{item.modelId}: {item.tokens} tokens · {item.costClass}</p>
          ))}
        </article>
      </section>
      <article className="card p-4">
        <h2 className="mb-3 font-medium">Recent activity</h2>
        {data.recentActivity.length === 0 ? <p className="text-sm text-slate-400">No activity yet.</p> : data.recentActivity.map((event) => (
          <p key={event.id} className="text-sm text-slate-300">{event.createdAt} · {event.message}</p>
        ))}
      </article>
    </div>
  );
}
