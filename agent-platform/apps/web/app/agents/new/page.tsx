"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { useToast } from "../../../components/Toast";

interface BoardOption { id: string; name: string }

export default function NewAgentPage() {
  const toast = useToast();
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    boardName: "",
    repositoryName: "",
    repositoryUrl: "",
    linkedRepositories: [] as string[],
    provider: "none",
    boardId: "",
    defaultBranch: "main",
    executorKind: "fake",
    dailyCapacityHours: 8,
    boardKey: "",
    boardToken: "",
  });
  const [boards, setBoards] = useState<BoardOption[]>([]);
  const [finding, setFinding] = useState(false);

  function update(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateLinked(index: number, value: string) {
    setForm((current) => ({
      ...current,
      linkedRepositories: current.linkedRepositories.map((item, itemIndex) => itemIndex === index ? value : item),
    }));
  }

  async function findBoards() {
    setFinding(true);
    try {
      const rows = form.provider === "github_projects"
        ? (await api<{ id: string; title: string }[]>("/api/integrations/github/projects", {
          method: "POST",
          body: JSON.stringify({ token: form.boardToken, owner: form.repositoryName.split("/")[0] ?? "", repo: form.repositoryName.split("/")[1] ?? "" }),
        })).map((item) => ({ id: item.id, name: item.title }))
        : await api<BoardOption[]>("/api/integrations/trello/boards", {
          method: "POST",
          body: JSON.stringify({ key: form.boardKey, token: form.boardToken }),
        });
      setBoards(rows);
      if (rows[0] && !form.boardId) setForm((current) => ({ ...current, boardId: rows[0].id, boardName: current.boardName || rows[0].name }));
      toast(rows.length ? `Found ${rows.length} board${rows.length === 1 ? "" : "s"}` : "No boards were returned", rows.length ? "success" : "warning");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load boards", "error");
    } finally {
      setFinding(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = await api<{ id: string; name: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          name: form.name || undefined,
          dailyCapacityHours: Number(form.dailyCapacityHours),
          boardKey: form.boardKey || undefined,
          boardToken: form.boardToken || undefined,
          linkedRepositories: form.linkedRepositories.map((item) => item.trim()).filter(Boolean),
        }),
      });
      toast(`${created.name} created`, "success");
      router.push(`/agents/${created.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create the agent", "error");
    }
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Create agent</h1>
        <p className="text-sm text-slate-400">Leave the name empty to use the board or repository name plus “Agent”.</p>
      </header>
      <section className="card space-y-3 p-4">
        <h2 className="font-medium">1. Agent</h2>
        <label className="block text-sm text-slate-300">Name
          <input className="input mt-1" aria-label="Name" value={form.name} onChange={(event) => update("name", event.target.value)} />
        </label>
        <label className="block text-sm text-slate-300">Executor
          <select className="input mt-1" aria-label="Executor" value={form.executorKind} onChange={(event) => update("executorKind", event.target.value)}>
            <option value="fake">Fake (no model calls)</option>
            <option value="llm">Model router</option>
            <option value="cursor">Cursor when the assigned provider is Cursor</option>
            <option value="codex">Codex when the assigned provider is Codex</option>
          </select>
        </label>
        <label className="block text-sm text-slate-300">Daily capacity hours
          <input className="input mt-1" aria-label="Daily capacity hours" type="number" min={1} max={24} value={form.dailyCapacityHours} onChange={(event) => update("dailyCapacityHours", event.target.value)} />
        </label>
      </section>
      <section className="card space-y-3 p-4">
        <h2 className="font-medium">2. Repository</h2>
        <label className="block text-sm text-slate-300">Primary repository URL
          <input className="input mt-1" aria-label="Primary repository URL" value={form.repositoryUrl} onChange={(event) => update("repositoryUrl", event.target.value)} placeholder="https://github.com/owner/name" />
        </label>
        <label className="block text-sm text-slate-300">Primary repository (owner/name)
          <input className="input mt-1" aria-label="Primary repository" value={form.repositoryName} onChange={(event) => update("repositoryName", event.target.value)} placeholder="owner/name" />
        </label>
        <label className="block text-sm text-slate-300">Default branch
          <input className="input mt-1" aria-label="Default branch" value={form.defaultBranch} onChange={(event) => update("defaultBranch", event.target.value)} />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm text-slate-300">Secondary / Linked Repositories (owner/name)</legend>
          {form.linkedRepositories.map((repository, index) => (
            <div key={index} className="flex gap-2">
              <input className="input" aria-label={`Secondary repository ${index + 1}`} value={repository} placeholder="owner/name" onChange={(event) => updateLinked(index, event.target.value)} />
              <button type="button" className="btn-ghost" onClick={() => setForm((current) => ({ ...current, linkedRepositories: current.linkedRepositories.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setForm((current) => ({ ...current, linkedRepositories: [...current.linkedRepositories, ""] }))}>Add repository</button>
        </fieldset>
      </section>
      <section className="card space-y-3 p-4">
        <h2 className="font-medium">3. Board</h2>
        <label className="block text-sm text-slate-300">Provider
          <select className="input mt-1" aria-label="Provider" value={form.provider} onChange={(event) => update("provider", event.target.value)}>
            <option value="none">None</option>
            <option value="trello">Trello</option>
            <option value="github_projects">GitHub Projects</option>
          </select>
        </label>
        {form.provider === "trello" ? (
          <>
            <label className="block text-sm text-slate-300">Trello API key
              <input className="input mt-1" aria-label="Trello API key" autoComplete="off" spellCheck={false} value={form.boardKey} onChange={(event) => update("boardKey", event.target.value)} />
            </label>
            <label className="block text-sm text-slate-300">Trello token
              <input className="input mt-1" aria-label="Trello token" autoComplete="off" spellCheck={false} value={form.boardToken} onChange={(event) => update("boardToken", event.target.value)} />
            </label>
            <p className="text-xs text-slate-500">Both the API key and the token are required to load lists and tickets.</p>
          </>
        ) : null}
        {form.provider === "github_projects" ? (
          <label className="block text-sm text-slate-300">GitHub token
            <input className="input mt-1" aria-label="GitHub token" autoComplete="off" spellCheck={false} value={form.boardToken} onChange={(event) => update("boardToken", event.target.value)} />
          </label>
        ) : null}
        {form.provider !== "none" ? (
          <button className="btn-ghost" type="button" disabled={finding} onClick={() => void findBoards()}>{finding ? "Looking…" : "Find boards"}</button>
        ) : null}
        {boards.length > 0 ? (
          <label className="block text-sm text-slate-300">Board
            <select className="input mt-1" aria-label="Board" value={form.boardId} onChange={(event) => {
              const board = boards.find((item) => item.id === event.target.value);
              setForm((current) => ({ ...current, boardId: event.target.value, boardName: board?.name ?? current.boardName }));
            }}>
              <option value="">Select a board</option>
              {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="block text-sm text-slate-300">Board or project name
          <input className="input mt-1" aria-label="Board or project name" value={form.boardName} onChange={(event) => update("boardName", event.target.value)} />
        </label>
        <label className="block text-sm text-slate-300">Board or project id
          <input className="input mt-1" aria-label="Board or project id" value={form.boardId} onChange={(event) => update("boardId", event.target.value)} />
        </label>
      </section>
      <button className="btn" type="submit">Create</button>
    </form>
  );
}
