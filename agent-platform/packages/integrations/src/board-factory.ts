import type { BoardClient } from "@agent-platform/core";
import type { TaskProvider } from "@agent-platform/shared";
import { listGithubProjectCards, moveGithubProjectCard } from "./github.js";
import { listTrelloCards, listTrelloLists, moveTrelloCard, trelloListId } from "./trello.js";

export function parseCredentials(raw: string, provider: TaskProvider): { key: string; token: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { key: "", token: "" };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { key?: string; token?: string };
      return { key: parsed.key ?? "", token: parsed.token ?? "" };
    } catch {
      return provider === "trello" ? { key: "", token: trimmed } : { key: "", token: "" };
    }
  }
  return { key: "", token: trimmed };
}

export async function listBoardColumns(input: {
  provider: TaskProvider;
  boardId: string;
  credentials: { key: string; token: string };
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  if (input.provider === "none" || !input.boardId || !input.credentials.token) return [];
  if (input.provider === "trello") {
    if (!input.credentials.key) return [];
    const lists = await listTrelloLists({ key: input.credentials.key, token: input.credentials.token }, input.boardId, input.fetchImpl);
    return lists.map((list) => list.name).filter(Boolean);
  }
  const project = await listGithubProjectCards(input.credentials.token, input.boardId, input.fetchImpl);
  return project.options.map((option) => option.name).filter(Boolean);
}

export function createBoardClient(input: {
  provider: TaskProvider;
  boardId: string;
  credentials: { key: string; token: string };
  fetchImpl?: typeof fetch;
}): BoardClient | null {
  if (input.provider === "none" || !input.boardId || !input.credentials.token) return null;
  if (input.provider === "trello") {
    const credentials = { key: input.credentials.key, token: input.credentials.token };
    return {
      async listCards() {
        return listTrelloCards(credentials, input.boardId, input.fetchImpl);
      },
      async moveCard(externalId, columnName) {
        const listId = await trelloListId(credentials, input.boardId, columnName, input.fetchImpl);
        if (!listId) throw new Error(`Trello list ${columnName} was not found`);
        await moveTrelloCard(credentials, externalId, listId, input.fetchImpl);
      },
    };
  }
  let fieldId = "";
  let options: { id: string; name: string }[] = [];
  return {
    async listCards() {
      const result = await listGithubProjectCards(input.credentials.token, input.boardId, input.fetchImpl);
      fieldId = result.statusFieldId;
      options = result.options;
      return result.cards;
    },
    async moveCard(externalId, columnName) {
      if (!fieldId) {
        const result = await listGithubProjectCards(input.credentials.token, input.boardId, input.fetchImpl);
        fieldId = result.statusFieldId;
        options = result.options;
      }
      const option = options.find((item) => item.name.trim().toLowerCase() === columnName.trim().toLowerCase());
      if (!option || !fieldId) throw new Error(`GitHub status ${columnName} was not found`);
      await moveGithubProjectCard(input.credentials.token, input.boardId, externalId, fieldId, option.id, input.fetchImpl);
    },
  };
}
