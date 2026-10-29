import { decryptSecret } from "@agent-platform/core";
import type { PlatformStore } from "@agent-platform/db";
import { parseCredentials, refreshStoredBoard } from "@agent-platform/integrations";

export async function syncConnectedBoards(store: PlatformStore, masterKey: string, fetchImpl?: typeof fetch): Promise<number> {
  let synced = 0;
  for (const agent of await store.listAgents()) {
    if (agent.provider !== "trello" || !agent.boardId || !agent.credentialSecretId) continue;
    try {
      const secret = await store.getSecret(agent.credentialSecretId);
      if (!secret) continue;
      const credentials = parseCredentials(decryptSecret(secret, masterKey), agent.provider);
      await refreshStoredBoard(store, agent, credentials, fetchImpl);
      synced += 1;
    } catch {
      continue;
    }
  }
  return synced;
}
