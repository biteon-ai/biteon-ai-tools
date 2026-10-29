"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Chip } from "../../components/ui";

interface Provider { id: string; name: string; type: string; costClass: string; baseUrl: string; credential: { configured: boolean; hint: string } }
interface Model { id: string; displayName: string; modelId: string; costClass: string; providerId: string }
interface Assignment { agentId: string | null; activity: string; modelId: string }

const PAID = new Set(["openai", "anthropic", "cursor", "codex"]);
const ACTIVITIES = ["planning", "coding", "testing", "review"];
const PRIMARY_ACTIVITIES = ["planning", "coding", "testing"];

export default function ModelsPage() {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [provider, setProvider] = useState({ name: "Ollama", type: "ollama", baseUrl: "http://host.docker.internal:11434/v1", costClass: "local", apiKey: "" });
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [model, setModel] = useState({ providerId: "", modelId: "", displayName: "", costClass: "local" });
  const [catalog, setCatalog] = useState<{ id: string; displayName: string }[]>([]);
  const [catalogNote, setCatalogNote] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [primaryOnAdd, setPrimaryOnAdd] = useState(false);

  function costFor(type: string): string {
    if (type === "ollama") return "local";
    if (PAID.has(type)) return "paid";
    return "hosted_free";
  }

  async function load() {
    const [nextProviders, nextModels, nextAssignments] = await Promise.all([
      api<Provider[]>("/api/providers"),
      api<Model[]>("/api/models"),
      api<Assignment[]>("/api/assignments"),
    ]);
    setProviders(nextProviders);
    setModels(nextModels);
    setAssignments(nextAssignments);
    if (nextProviders[0]) setModel((current) => current.providerId ? current : { ...current, providerId: nextProviders[0]!.id, costClass: nextProviders[0]!.costClass });
  }

  function globalAssignments(): Assignment[] {
    return assignments.filter((item) => item.agentId === null);
  }

  function isPrimary(item: Model): boolean {
    return globalAssignments().some((assignment) => assignment.activity === "coding" && assignment.modelId === item.id);
  }

  useEffect(() => { void load().catch((err: Error) => toast(err.message, "error")); }, [toast]);
  useEffect(() => {
    if (!model.providerId) return;
    let cancelled = false;
    setLoadingCatalog(true);
    setCatalogNote("");
    void api<{ models: { id: string; displayName: string }[] }>(`/api/providers/${model.providerId}/models`).then((result) => {
      if (cancelled) return;
      setCatalog(result.models);
      const first = result.models[0];
      setModel((current) => {
        if (current.providerId !== model.providerId) return current;
        const chosen = result.models.find((item) => item.id === current.modelId) ?? first;
        return chosen ? { ...current, modelId: chosen.id, displayName: current.modelId === chosen.id && current.displayName ? current.displayName : chosen.displayName } : { ...current, modelId: "", displayName: "" };
      });
      setCatalogNote(result.models.length ? `${result.models.length} models from this provider. Pick one and change the display name if you want.` : "This provider returned no models.");
    }).catch((err: Error) => {
      if (cancelled) return;
      setCatalog([]);
      setModel((current) => current.providerId === model.providerId ? { ...current, modelId: "", displayName: "" } : current);
      setCatalogNote(err.message);
    }).finally(() => {
      if (!cancelled) setLoadingCatalog(false);
    });
    return () => { cancelled = true; };
  }, [model.providerId]);

  function matchingProvider() {
    const name = provider.name.trim().toLowerCase();
    return providers.find((item) => {
      if (item.id === editingProviderId) return false;
      return item.name.trim().toLowerCase() === name || (provider.type !== "custom" && item.type === provider.type);
    });
  }

  async function addProvider(event: React.FormEvent) {
    event.preventDefault();
    if (savingProvider) return;
    const already = matchingProvider();
    setSavingProvider(true);
    try {
      const costClass = provider.type === "custom" ? provider.costClass : costFor(provider.type);
      const payload = { ...provider, costClass, apiKey: provider.apiKey || undefined };
      const editing = editingProviderId;
      const saved = editing
        ? await api<{ id: string }>(`/api/providers/${editing}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await api<{ id: string; updated?: boolean }>("/api/providers", { method: "POST", body: JSON.stringify(payload) });
      setProvider({ name: "Ollama", type: "ollama", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "", costClass: "local" });
      setEditingProviderId(null);
      await load();
      if (already || ("updated" in saved && saved.updated)) toast("Provider already exists. Updated existing settings.", "warning");
      else if (editing) toast("Provider settings saved", "success");
      else toast(`${provider.name} added as ${costClass}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the provider", "error");
    } finally {
      setSavingProvider(false);
    }
  }

  function cancelEdit() {
    setEditingProviderId(null);
    setProvider({ name: "Ollama", type: "ollama", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "", costClass: "local" });
  }

  async function removeProvider(item: Provider) {
    if (!window.confirm(`Remove ${item.name}? Models assigned to it will be unlinked.`)) return;
    try {
      await api(`/api/providers/${item.id}`, { method: "DELETE" });
      if (editingProviderId === item.id) setEditingProviderId(null);
      await load();
      toast(`${item.name} removed`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove the provider", "error");
    }
  }

  async function addModel(event: React.FormEvent) {
    event.preventDefault();
    const duplicate = models.some((item) => item.providerId === model.providerId && (
      item.modelId.trim().toLowerCase() === model.modelId.trim().toLowerCase()
      || item.displayName.trim().toLowerCase() === model.displayName.trim().toLowerCase()
    ));
    if (duplicate) {
      toast("This provider already has that model", "error");
      return;
    }
    try {
      const saved = await api<Model>("/api/models", { method: "POST", body: JSON.stringify(model) });
      if (primaryOnAdd) await saveActivities(saved, PRIMARY_ACTIVITIES);
      setPrimaryOnAdd(false);
      await load();
      toast(primaryOnAdd ? `${model.displayName} added as the primary model` : `${model.displayName} added`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the model", "error");
    }
  }

  async function saveActivities(item: Model, activities: string[]) {
    for (const activity of activities) {
      await api("/api/assignments", { method: "PUT", body: JSON.stringify({ activity, modelId: item.id, agentId: null, fallbackModelId: null, maxTokens: 4000, dailyTokenBudget: null, allowLocalOnly: false, requirePaid: false }) });
    }
  }

  async function assign(activity: string, item: Model) {
    try {
      await saveActivities(item, [activity]);
      await load();
      toast(`${activity} now uses ${item.displayName}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not assign the model", "error");
    }
  }

  async function makePrimary(item: Model) {
    try {
      await saveActivities(item, PRIMARY_ACTIVITIES);
      await load();
      toast(`${item.displayName} is the primary model`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not set the primary model", "error");
    }
  }

  const providerCost = provider.type === "custom" ? provider.costClass : costFor(provider.type);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-slate-400">Ollama stays labeled local. OpenAI, Anthropic, Cursor, and Codex stay labeled paid.</p>
      </header>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-slate-200">Providers</h2>
          <p className="text-sm text-slate-500">A built-in type such as Ollama is saved once. Submitting it again updates that provider.</p>
        </div>
        <form onSubmit={addProvider} autoComplete="off" className="card space-y-4 p-4 md:p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Name</span>
              <input className="input" aria-label="Provider name" autoComplete="off" value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Type</span>
              <select className="input" aria-label="Provider type" value={provider.type} onChange={(event) => setProvider({ ...provider, type: event.target.value, costClass: costFor(event.target.value) })}>
                {["ollama", "openai", "anthropic", "cursor", "codex", "custom"].map((type) => <option key={type}>{type}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5 md:col-span-2">
              <span className="text-xs font-medium text-slate-400">Base URL</span>
              <input className="input font-mono text-[13px]" aria-label="Base URL" autoComplete="off" spellCheck={false} value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="http://host.docker.internal:11434/v1" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">API key</span>
              <input type="password" className="input" aria-label="API key" autoComplete="new-password" spellCheck={false} value={provider.apiKey} onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })} placeholder={editingProviderId ? "Leave blank to keep the saved key" : "Optional"} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Cost class</span>
              {provider.type === "custom" ? (
                <select className="input" aria-label="Cost class" value={provider.costClass} onChange={(event) => setProvider({ ...provider, costClass: event.target.value })}>
                  <option value="local">local</option>
                  <option value="hosted_free">hosted_free</option>
                  <option value="paid">paid</option>
                </select>
              ) : (
                <div className="flex h-[38px] items-center"><Chip>{providerCost}</Chip></div>
              )}
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 pt-4">
            {editingProviderId ? <button className="btn-ghost" type="button" onClick={cancelEdit}>Cancel</button> : null}
            <button className="btn" type="submit" disabled={savingProvider} aria-busy={savingProvider}>
              {savingProvider ? <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-950 border-t-transparent" style={{ animation: "spin 0.7s linear infinite" }} /> : null}
              {savingProvider ? "Saving…" : editingProviderId ? "Save provider" : "Add provider"}
            </button>
          </div>
        </form>
        {providers.length === 0 ? <p className="text-sm text-slate-500">No providers yet.</p> : (
          <ul className="space-y-2">
            {providers.map((item) => (
              <li key={item.id} className={`card px-4 py-3 ${editingProviderId === item.id ? "border-sky-500/60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      <Chip>{item.type}</Chip>
                      <Chip>{item.costClass}</Chip>
                    </div>
                    <p className="truncate font-mono text-xs text-slate-400" title={item.baseUrl || "No base URL"}>{item.baseUrl || "No base URL"}</p>
                    <p className="text-xs text-slate-500">{item.credential.configured ? `Key ${item.credential.hint}` : "No API key"}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-ghost" type="button" onClick={() => {
                      setEditingProviderId(item.id);
                      setProvider({ name: item.name, type: item.type, baseUrl: item.baseUrl, costClass: item.costClass, apiKey: "" });
                    }}>Edit</button>
                    <button className="btn-ghost" type="button" onClick={() => void removeProvider(item)}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-slate-200">Models</h2>
          <p className="text-sm text-slate-500">Each provider loads its own model list. The primary model is listed first and runs planning, coding, and testing.</p>
        </div>
        <form onSubmit={addModel} autoComplete="off" className="card space-y-4 p-4 md:p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Provider</span>
              <select className="input" aria-label="Model provider" value={model.providerId} onChange={(event) => {
                const selected = providers.find((item) => item.id === event.target.value);
                setModel({ ...model, providerId: event.target.value, costClass: selected?.costClass ?? model.costClass });
              }}>
                {providers.length === 0 ? <option value="">Add a provider first</option> : null}
                {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Model</span>
              <select className="input" aria-label="Model" value={model.modelId} disabled={loadingCatalog || catalog.length === 0} onChange={(event) => {
                const chosen = catalog.find((item) => item.id === event.target.value);
                setModel({ ...model, modelId: event.target.value, displayName: chosen?.displayName ?? event.target.value });
              }}>
                {catalog.length === 0 ? <option value="">{loadingCatalog ? "Loading models…" : "No models loaded"}</option> : null}
                {catalog.map((item) => <option key={item.id} value={item.id}>{item.displayName === item.id ? item.displayName : `${item.displayName} · ${item.id}`}</option>)}
              </select>
              {catalogNote ? <span className="block text-xs text-slate-500">{catalogNote}</span> : null}
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Display name</span>
              <input className="input" aria-label="Display name" autoComplete="off" value={model.displayName} onChange={(event) => setModel({ ...model, displayName: event.target.value })} placeholder="Qwen" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-400">Cost class</span>
              <div className="flex h-[38px] items-center"><Chip>{model.costClass || "Set by the provider"}</Chip></div>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" aria-label="Make this the primary model" checked={primaryOnAdd} onChange={(event) => setPrimaryOnAdd(event.target.checked)} />
              Make this the primary model
            </label>
            <button className="btn" type="submit" disabled={providers.length === 0 || !model.modelId || loadingCatalog}>{loadingCatalog ? "Loading models…" : "Add model"}</button>
          </div>
        </form>
        {models.length === 0 ? <p className="text-sm text-slate-500">No models yet.</p> : (
          <ul className="space-y-2">
            {[...models].sort((left, right) => Number(isPrimary(right)) - Number(isPrimary(left))).map((item) => {
              const owner = providers.find((providerItem) => providerItem.id === item.providerId);
              const primary = isPrimary(item);
              const assigned = new Set(globalAssignments().filter((assignment) => assignment.modelId === item.id).map((assignment) => assignment.activity));
              return (
                <li key={item.id} className={`card px-4 py-3 ${primary ? "border-sky-500/60" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.displayName}</span>
                        {primary ? <Chip>Primary</Chip> : null}
                        <Chip>{item.costClass}</Chip>
                        {owner ? <Chip>{owner.name}</Chip> : null}
                      </div>
                      <p className="truncate font-mono text-xs text-slate-500">{item.modelId}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button className={primary ? "btn" : "btn-ghost"} type="button" disabled={primary} onClick={() => void makePrimary(item)}>{primary ? "Primary" : "Make primary"}</button>
                      {ACTIVITIES.map((activity) => (
                        <button key={activity} className={`${assigned.has(activity) ? "btn" : "btn-ghost"} capitalize`} onClick={() => void assign(activity, item)} type="button">{activity}</button>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
