"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Icon } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Modal, Toggle } from "../../components/ui";

interface Telegram { enabled: boolean; chatId: string; minSeverity: string; digestMinutes: number; credential: { configured: boolean; hint: string } }
interface Notice { id: string; title: string; body: string; severity: string; createdAt: string }
interface Pairing { token: string; botUsername: string; url: string; svg: string; expiresAt: string }
interface PairStatus { status: "pending" | "paired"; chatId: string; enabled: boolean }

export default function NotificationsPage() {
  const toast = useToast();
  const [config, setConfig] = useState<Telegram | null>(null);
  const [token, setToken] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState(false);

  async function load() {
    const [telegram, items] = await Promise.all([api<Telegram>("/api/telegram"), api<Notice[]>("/api/notifications")]);
    setConfig(telegram);
    setNotices(items);
    if (telegram.chatId) setPaired(true);
  }

  useEffect(() => { void load().catch((err: Error) => toast(err.message, "error")); }, [toast]);

  useEffect(() => {
    if (!pairing) return;
    let stop = false;
    const timer = window.setInterval(() => {
      void api<PairStatus>(`/api/telegram/pair/${pairing.token}`).then((status) => {
        if (stop || status.status !== "paired") return;
        stop = true;
        setConfig((current) => current ? { ...current, chatId: status.chatId, enabled: status.enabled || current.enabled } : current);
        setPaired(true);
        toast("Successfully paired", "success");
        window.setTimeout(() => setPairing(null), 900);
      }).catch(() => undefined);
    }, 2000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [pairing, toast]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!config) return;
    try {
      const saved = await api<Telegram>("/api/telegram", {
        method: "PUT",
        body: JSON.stringify({ ...config, botToken: token || undefined }),
      });
      setConfig(saved);
      setToken("");
      if (saved.chatId) setPaired(true);
      toast("Telegram settings saved. The token is stored encrypted.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save Telegram settings", "error");
    }
  }

  async function startPairing() {
    try {
      const session = await api<Pairing>("/api/telegram/pair", { method: "POST" });
      setPairing(session);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start pairing", "error");
    }
  }

  async function sendTest() {
    try {
      await api("/api/telegram/test", { method: "POST" });
      toast("Test alert sent", "success");
      setNotices(await api<Notice[]>("/api/notifications"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send the test alert", "error");
    }
  }

  if (!config) return <p className="text-sm text-slate-400">Loading notifications…</p>;
  return (
    <div className="space-y-6">
      <form onSubmit={save} className="card max-w-xl space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Telegram</h1>
          {paired && config.chatId ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
              <Icon name="check" /> Successfully Paired
            </span>
          ) : null}
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Enabled</span>
          <Toggle checked={config.enabled} label="Enabled" onChange={(enabled) => setConfig({ ...config, enabled })} />
        </label>
        <input className="input" aria-label="Chat id" placeholder="Chat id" value={config.chatId} onChange={(event) => setConfig({ ...config, chatId: event.target.value })} />
        <select className="input" aria-label="Minimum severity" value={config.minSeverity} onChange={(event) => setConfig({ ...config, minSeverity: event.target.value })}>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="urgent">urgent</option>
        </select>
        <input type="password" className="input" aria-label="Bot token" placeholder={config.credential.configured ? config.credential.hint : "Bot token"} value={token} onChange={(event) => setToken(event.target.value)} />
        <p className="text-sm text-slate-400">Save the bot token first, then pair this browser with Telegram. Routine info is digested. Warnings and urgent messages send immediately when they meet the minimum severity.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="submit">Save</button>
          <button className="btn-ghost" type="button" onClick={() => void startPairing()} disabled={!config.credential.configured}>Pair with Telegram</button>
          <button className="btn-ghost" type="button" onClick={() => void sendTest()}>Send Test Telegram Alert</button>
        </div>
      </form>
      {pairing ? (
        <Modal title="Pair with Telegram" onClose={() => setPairing(null)}>
          <div className="space-y-4 text-center">
            <div className="mx-auto w-fit rounded-xl bg-white p-3" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
            <p className="text-sm text-slate-400">Scan the code or open the bot. The chat id fills in when Telegram sends <span className="font-mono text-slate-200">/start pair_…</span></p>
            <a className="btn w-full" href={pairing.url} target="_blank" rel="noreferrer">Open {pairing.botUsername}</a>
          </div>
        </Modal>
      ) : null}
      <section className="card p-4">
        <h2 className="mb-3 font-medium">Recent notifications</h2>
        {notices.length === 0 ? <p className="text-sm text-slate-400">No notifications yet.</p> : notices.map((notice) => (
          <p key={notice.id} className="mb-2 text-sm"><span className="text-amber-300">{notice.severity}</span> {notice.title}</p>
        ))}
      </section>
    </div>
  );
}
