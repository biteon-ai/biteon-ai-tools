import { describe, expect, it } from "vitest";
import { MemoryStore } from "@agent-platform/db";
import { memoryPairingStore } from "@agent-platform/integrations";
import { consumeTelegramUpdates } from "./telegram-updates.js";

describe("telegram updates", () => {
  it("pairs a chat from /start and ignores other chats", async () => {
    const store = new MemoryStore();
    const token = "0123456789abcdef0123456789abcdef";
    const pairing = memoryPairingStore();
    await pairing.save({
      token,
      status: "pending",
      chatId: "",
      botUsername: "AgentPlatformBot",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const sent: string[] = [];
    await consumeTelegramUpdates({
      store,
      pairing,
      token: "bot-token",
      masterKey: "0123456789abcdef0123456789abcdef",
      updates: [
        { update_id: 1, message: { text: `/start pair_${token}`, chat: { id: 4242 } } },
        { update_id: 2, message: { text: "/status", chat: { id: 999 } } },
        { update_id: 3, message: { text: "/status", chat: { id: 4242 } } },
      ],
      send: async (chatId, text) => { sent.push(`${chatId}:${text}`); },
    });
    expect((await store.getTelegramConfig())?.chatId).toBe("4242");
    expect((await store.getTelegramConfig())?.enabled).toBe(true);
    expect(sent[0]).toContain("Paired");
    expect(sent.some((line) => line.startsWith("999:"))).toBe(false);
    expect(sent.some((line) => line.startsWith("4242:") && line.includes("No agents"))).toBe(true);
  });
});