import { emptyTelegramConfig } from "@agent-platform/shared";
import type { PlatformStore } from "@agent-platform/db";
import { parsePairingStart, sendTelegramMessage, type PairingStore, type TelegramUpdate } from "@agent-platform/integrations";
import { handleTelegramCommand } from "./commands.js";

export async function consumeTelegramUpdates(input: {
  store: PlatformStore;
  pairing: PairingStore;
  token: string;
  updates: TelegramUpdate[];
  masterKey: string;
  send?: (chatId: string, text: string) => Promise<void>;
  enqueue?: (agentId: string) => Promise<void>;
}): Promise<void> {
  const send = input.send ?? ((chatId, text) => sendTelegramMessage(input.token, chatId, text));
  for (const update of input.updates) {
    const chat = String(update.message?.chat?.id ?? "");
    const text = update.message?.text ?? "";
    if (!chat) continue;
    const pairingToken = parsePairingStart(text);
    if (pairingToken) {
      const session = await input.pairing.complete(pairingToken, chat);
      if (!session) {
        await send(chat, "That pairing link has expired. Start again from Agent Platform.");
        continue;
      }
      const config = (await input.store.getTelegramConfig()) ?? emptyTelegramConfig();
      config.chatId = chat;
      config.enabled = true;
      await input.store.saveTelegramConfig(config);
      await send(chat, "Paired with Agent Platform. This chat will receive alerts.");
      continue;
    }
    const config = await input.store.getTelegramConfig();
    if (!config?.chatId || chat !== config.chatId) continue;
    await send(chat, await handleTelegramCommand(input.store, text, input.masterKey, { enqueue: input.enqueue }));
  }
}
