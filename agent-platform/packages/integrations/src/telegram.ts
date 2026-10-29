import { redact } from "@agent-platform/core";

type FetchLike = typeof fetch;

export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number } };
}

export async function sendTelegramMessage(token: string, chatId: string, text: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!response.ok) throw new Error(`Telegram send failed with status ${response.status}`);
}

export async function telegramBotProfile(token: string, fetchImpl: FetchLike = fetch): Promise<{ username: string }> {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
  if (!response.ok) throw new Error("Telegram bot lookup failed");
  const body = await response.json() as { ok?: boolean; result?: { username?: string } };
  const username = body.result?.username?.trim() ?? "";
  if (!body.ok || !/^[A-Za-z0-9_]{4,32}$/.test(username)) throw new Error("Telegram bot has no public username");
  return { username };
}

export async function pollTelegram(token: string, offset: number, fetchImpl: FetchLike = fetch): Promise<TelegramUpdate[]> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("timeout", "0");
  url.searchParams.set("offset", String(offset));
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error("Telegram poll failed");
  const body = await response.json() as { ok?: boolean; result?: TelegramUpdate[] };
  if (!body.ok) throw new Error(redact("Telegram poll was rejected"));
  return body.result ?? [];
}
