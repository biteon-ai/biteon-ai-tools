"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { useToast } from "../../../components/Toast";

interface BoardOption { id: string; name: string }
interface GithubRepoOption { fullName: string; htmlUrl: string; defaultBranch: string }

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
    defaultBranch: "develop",
    executorKind: "fake",
    dailyCapacityHours: 8,
    boardKey: "",
    boardToken: "",
    repositoryToken: "",
  });
  const [boards, setBoards] = useState<BoardOption[]>([]);
  const [finding, setFinding] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [githubAccount, setGithubAccount] = useState<{ login: string; name: string | null } | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepoOption[]>([]);

  function update(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateLinked(index: number, value: string) {
    setForm((current) => ({
      ...current,
      linkedRepositories: current.linkedRepositories.map((item, itemIndex) => itemIndex === index ? value : item),
    }));
  }

  function selectPrimaryRepository(fullName: string) {
    const selected = githubRepos.find((item) => item.fullName === fullName);
    setForm((current) => ({
      ...current,
      repositoryName: fullName,
      repositoryUrl: selected?.htmlUrl ?? current.repositoryUrl,
      defaultBranch: selected?.defaultBranch || current.defaultBranch,
      linkedRepositories: current.linkedRepositories.filter((item) => item.trim().toLowerCase() !== fullName.toLowerCase()),
    }));
  }

  async function connectGithub() {
    const token = form.repositoryToken.trim();
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
      if (!form.repositoryName && result.repositories[0]) {
        const first = result.repositories[0];
        setForm((current) => ({
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

  async function findBoards() {
    setFinding(true);
    try {
      const rows = form.provider === "github_projects"
        ? (await api<{ id: string; title: string }[]>("/api/integrations/github/projects", {
          method: "POST",
          body: JSON.stringify({ token: form.boardToken || form.repositoryToken, owner: form.repositoryName.split("/")[0] ?? "", repo: form.repositoryName.split("/")[1] ?? "" }),
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
    if (!form.repositoryName.trim() && !form.repositoryUrl.trim()) {
      toast("A primary repository name or URL is required", "warning");
      return;
    }
    if (!form.repositoryToken.trim()) {
      toast("Connect and authenticate a GitHub account for the repository", "warning");
      return;
    }
    try {
      const created = await api<{ id: string; name: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          name: form.name || undefined,
          dailyCapacityHours: Number(form.dailyCapacityHours),
          boardKey: form.boardKey || undefined,
          boardToken: form.boardToken || undefined,
          repositoryToken: form.repositoryToken,
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
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create agent</h1>
        <p className="text-sm text-slate-400">Leave the name empty to use the board or repository name plus “Agent”.</p>
      </header>

      <section className="card space-y-3 p-4">
        <header className="space-y-1 border-b border-slate-800 pb-3">
          <h2 className="text-sm font-semibold text-slate-100">1. Agent</h2>
          <p className="text-sm text-slate-400">Name and how this agent runs work.</p>
        </header>
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

      <section className="card space-y-4 p-4">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-100">2. GitHub repository</h2>
            <p className="text-sm text-slate-400">Required. Authenticate a GitHub account, then choose the primary and linked repositories.</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${githubAccount ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
            {githubAccount ? `Connected @${githubAccount.login}` : "Not connected"}
          </span>
        </header>

        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Connect account</h3>
            <p className="mt-1 text-xs text-slate-500">Paste a personal access token, then connect so the agent can clone, push, and open pull requests.</p>
          </div>
          <label className="block text-sm text-slate-300">GitHub personal access token
            <input className="input mt-1" aria-label="GitHub personal access token" autoComplete="off" spellCheck={false} required value={form.repositoryToken} onChange={(event) => update("repositoryToken", event.target.value)} placeholder="ghp_… or github_pat_…" />
          </label>
          <button className="btn" type="button" disabled={connectingGithub || !form.repositoryToken.trim()} onClick={() => void connectGithub()}>{connectingGithub ? "Connecting…" : "Connect GitHub account"}</button>
          {githubAccount ? <p className="text-sm text-emerald-300">Signed in as @{githubAccount.login}{githubAccount.name ? ` · ${githubAccount.name}` : ""}</p> : null}
        </div>

        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Primary repository</h3>
            <p className="mt-1 text-xs text-slate-500">The main repo this agent works in. Pick one from the connected account or enter it manually.</p>
          </div>
          {githubRepos.length > 0 ? (
            <label className="block text-sm text-slate-300">Choose from connected account
              <select className="input mt-1" aria-label="Choose a repository from this account" value={form.repositoryName} onChange={(event) => selectPrimaryRepository(event.target.value)}>
                <option value="">Select a repository</option>
                {githubRepos.map((repository) => <option key={repository.fullName} value={repository.fullName}>{repository.fullName}</option>)}
              </select>
            </label>
          ) : null}
          <label className="block text-sm text-slate-300">Primary repository URL
            <input className="input mt-1" aria-label="Primary repository URL" required={!form.repositoryName.trim()} value={form.repositoryUrl} onChange={(event) => update("repositoryUrl", event.target.value)} placeholder="https://github.com/owner/name" />
          </label>
          <label className="block text-sm text-slate-300">Primary repository (owner/name)
            <input className="input mt-1" aria-label="Primary repository" required={!form.repositoryUrl.trim()} value={form.repositoryName} onChange={(event) => update("repositoryName", event.target.value)} placeholder="owner/name" />
          </label>
          <label className="block text-sm text-slate-300">Default branch
            <input className="input mt-1" aria-label="Default branch" value={form.defaultBranch} onChange={(event) => update("defaultBranch", event.target.value)} />
          </label>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Linked repositories</h3>
            <p className="mt-1 text-xs text-slate-500">Optional secondary repos from the same GitHub account.</p>
          </div>
          {form.linkedRepositories.map((repository, index) => (
            <div key={index} className="flex gap-2">
              {githubRepos.length > 0 ? (
                <select className="input" aria-label={`Secondary repository ${index + 1}`} value={repository} onChange={(event) => updateLinked(index, event.target.value)}>
                  <option value="">Select a repository</option>
                  {githubRepos.filter((item) => item.fullName === repository || item.fullName.toLowerCase() !== form.repositoryName.trim().toLowerCase()).map((item) => (
                    <option key={item.fullName} value={item.fullName}>{item.fullName}</option>
                  ))}
                </select>
              ) : (
                <input className="input" aria-label={`Secondary repository ${index + 1}`} value={repository} placeholder="owner/name" onChange={(event) => updateLinked(index, event.target.value)} />
              )}
              <button type="button" className="btn-ghost" onClick={() => setForm((current) => ({ ...current, linkedRepositories: current.linkedRepositories.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setForm((current) => ({ ...current, linkedRepositories: [...current.linkedRepositories, ""] }))}>Add repository</button>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <header className="space-y-1 border-b border-slate-800 pb-3">
          <h2 className="text-sm font-semibold text-slate-100">3. Board</h2>
          <p className="text-sm text-slate-400">Optional ticket board this agent reads and updates.</p>
        </header>
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
          <label className="block text-sm text-slate-300">GitHub Projects token
            <input className="input mt-1" aria-label="GitHub Projects token" autoComplete="off" spellCheck={false} value={form.boardToken} onChange={(event) => update("boardToken", event.target.value)} placeholder="Leave blank to reuse the repository token" />
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

      <div className="flex justify-end">
        <button className="btn" type="submit">Create</button>
      </div>
    </form>
  );
}
