"use client";

import type { ReactNode } from "react";
import { Icon } from "./Icons";

const statusStyles: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  stopped: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  error: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  created: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};

export function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? statusStyles.created;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 ${style}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "bg-emerald-400" : status === "paused" ? "bg-amber-400" : status === "stopped" || status === "error" ? "bg-rose-400" : "bg-slate-400"}`} />
      {status}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-full border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-300">{children}</span>;
}

export function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-sky-500" : "bg-slate-700"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${checked ? "left-5" : "left-0.5"}`} />
    </button>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-md p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CommandList({ commands, onChange }: { commands: string[]; onChange: (commands: string[]) => void }) {
  return (
    <div className="space-y-2">
      {commands.length === 0 ? <p className="text-sm text-slate-500">No validation commands yet.</p> : commands.map((command, index) => (
        <div key={index} className="flex gap-2">
          <input className="input font-mono" value={command} aria-label={`Validation command ${index + 1}`} onChange={(event) => onChange(commands.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="pnpm test" />
          <button type="button" className="btn-ghost" onClick={() => onChange(commands.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn-ghost" onClick={() => onChange([...commands, ""])}>Add command</button>
    </div>
  );
}
