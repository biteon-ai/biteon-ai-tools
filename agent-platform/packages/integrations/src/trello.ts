import type { ExternalCard } from "@agent-platform/shared";
import { redact } from "@agent-platform/core";

export interface TrelloCredentials {
  key: string;
  token: string;
}

type FetchLike = typeof fetch;

export async function listTrelloBoards(credentials: TrelloCredentials, fetchImpl: FetchLike = fetch): Promise<{ id: string; name: string }[]> {
  const body = await trelloGet<Array<{ id: string; name: string }>>(fetchImpl, "/members/me/boards", credentials);
  return body.map((board) => ({ id: board.id, name: board.name }));
}

export async function listTrelloLists(credentials: TrelloCredentials, boardId: string, fetchImpl: FetchLike = fetch): Promise<{ id: string; name: string }[]> {
  return trelloGet<Array<{ id: string; name: string }>>(fetchImpl, `/boards/${encodeURIComponent(boardId)}/lists`, credentials);
}

export async function listTrelloCards(credentials: TrelloCredentials, boardId: string, fetchImpl: FetchLike = fetch): Promise<ExternalCard[]> {
  const lists = await listTrelloLists(credentials, boardId, fetchImpl);
  const cards = await trelloGet<Array<{ id: string; name: string; desc: string; idList: string; url: string; labels?: { name: string }[]; due: string | null; pos?: number }>>(
    fetchImpl,
    `/boards/${encodeURIComponent(boardId)}/cards?fields=id,name,desc,idList,url,labels,due,pos&filter=open`,
    credentials,
  );
  const names = new Map(lists.map((list) => [list.id, list.name]));
  const byList = new Map<string, typeof cards>();
  for (const card of cards) {
    const bucket = byList.get(card.idList) ?? [];
    bucket.push(card);
    byList.set(card.idList, bucket);
  }
  const ordered = lists.flatMap((list) => (byList.get(list.id) ?? []).sort((left, right) => cardPosition(left.pos) - cardPosition(right.pos)));
  const known = new Set(ordered.map((card) => card.id));
  ordered.push(...cards.filter((card) => !known.has(card.id)));
  return ordered.map((card, index) => ({
    externalId: card.id,
    title: card.name,
    description: card.desc ?? "",
    acceptanceCriteria: "",
    columnName: names.get(card.idList) ?? "",
    url: card.url ?? "",
    comments: [],
    labels: (card.labels ?? []).map((label) => label.name).filter(Boolean),
    dueAt: card.due,
    priority: 3,
    position: cardPosition(card.pos, index),
  }));
}

function cardPosition(value: unknown, fallback = Number.MAX_SAFE_INTEGER): number {
  const position = typeof value === "number" ? value : Number(value);
  return Number.isFinite(position) ? position : fallback;
}

export async function moveTrelloCard(credentials: TrelloCredentials, cardId: string, listId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const url = new URL(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`);
  url.searchParams.set("idList", listId);
  url.searchParams.set("key", credentials.key);
  url.searchParams.set("token", credentials.token);
  const response = await fetchImpl(url, { method: "PUT" });
  if (!response.ok) throw new Error(`Trello request failed with status ${response.status}`);
}

export async function trelloListId(credentials: TrelloCredentials, boardId: string, columnName: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const lists = await listTrelloLists(credentials, boardId, fetchImpl);
  const needle = normalizeListName(columnName);
  return lists.find((list) => normalizeListName(list.name) === needle)?.id ?? null;
}

function normalizeListName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export async function registerTrelloWebhook(credentials: TrelloCredentials, boardId: string, callbackUrl: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!credentials.key || !credentials.token || !boardId || !callbackUrl) {
    return { ok: false, error: "Trello webhook needs an API key, token, board, and a public callback URL." };
  }
  const url = new URL("https://api.trello.com/1/webhooks");
  url.searchParams.set("key", credentials.key);
  url.searchParams.set("token", credentials.token);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Agent Platform board sync",
      callbackURL: callbackUrl,
      idModel: boardId,
    }),
  });
  if (response.ok) {
    const payload = await response.json() as { id?: string };
    return { ok: true, id: payload.id ?? "" };
  }
  const text = await response.text().catch(() => "");
  if (response.status === 400 && /already exists/i.test(text)) return { ok: true, id: "" };
  return { ok: false, error: `Trello webhook was not registered (${response.status}).` };
}

export interface TrelloCardMove {
  boardId: string;
  cardId: string;
  cardName: string;
  listId: string;
  listName: string;
}

export function readTrelloCardMove(body: unknown): TrelloCardMove | null {
  if (!body || typeof body !== "object") return null;
  const action = (body as { action?: unknown }).action;
  if (!action || typeof action !== "object") return null;
  const record = action as {
    type?: string;
    display?: { translationKey?: string };
    data?: {
      card?: { id?: string; name?: string; idList?: string };
      board?: { id?: string };
      listAfter?: { id?: string; name?: string };
      old?: { idList?: string };
    };
  };
  const key = record.display?.translationKey ?? "";
  const listId = record.data?.listAfter?.id || record.data?.card?.idList || "";
  const moved = key === "action_moved_card_lower"
    || key === "action_move_card_from_list_to_list"
    || (record.type === "updateCard" && Boolean(listId) && Boolean(record.data?.listAfter || record.data?.old?.idList));
  const cardId = record.data?.card?.id ?? "";
  const boardId = record.data?.board?.id ?? "";
  if (!moved || !cardId || !boardId || !listId) return null;
  return {
    boardId,
    cardId,
    cardName: record.data?.card?.name ?? "",
    listId,
    listName: record.data?.listAfter?.name ?? "",
  };
}

async function trelloGet<T>(fetchImpl: FetchLike, pathname: string, credentials: TrelloCredentials): Promise<T> {
  const url = new URL(`https://api.trello.com/1${pathname}`);
  url.searchParams.set("key", credentials.key);
  url.searchParams.set("token", credentials.token);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Trello request failed with status ${response.status}`);
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : "Trello response was not JSON"));
  }
}
