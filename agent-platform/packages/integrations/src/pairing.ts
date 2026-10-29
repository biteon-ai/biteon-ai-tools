export const PAIRING_TTL_SECONDS = 600;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export interface PairingSession {
  token: string;
  status: "pending" | "paired";
  chatId: string;
  botUsername: string;
  expiresAt: string;
}

export interface PairingCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export interface PairingStore {
  save(session: PairingSession): Promise<void>;
  get(token: string): Promise<PairingSession | null>;
  complete(token: string, chatId: string): Promise<PairingSession | null>;
}

export function parsePairingStart(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+pair_([a-f0-9]{32})$/i);
  const token = match?.[1]?.toLowerCase() ?? "";
  return TOKEN_PATTERN.test(token) ? token : null;
}

export function telegramDeepLink(username: string, token: string): string {
  return `https://t.me/${username}?start=pair_${token}`;
}

export function createPairingStore(cache: PairingCache): PairingStore {
  return {
    async save(session) {
      await cache.set(pairingKey(session.token), JSON.stringify(session), "EX", PAIRING_TTL_SECONDS);
    },
    async get(token) {
      const raw = await cache.get(pairingKey(token)).catch(() => null);
      return readSession(raw);
    },
    async complete(token, chatId) {
      const key = pairingKey(token);
      const current = readSession(await cache.get(key).catch(() => null));
      if (!current) return null;
      const next: PairingSession = { ...current, status: "paired", chatId };
      const remaining = await cache.ttl(key).catch(() => PAIRING_TTL_SECONDS);
      const seconds = remaining > 0 ? remaining : PAIRING_TTL_SECONDS;
      await cache.set(key, JSON.stringify(next), "EX", seconds);
      return next;
    },
  };
}

export function memoryPairingStore(now = (): number => Date.now()): PairingStore {
  const sessions = new Map<string, PairingSession>();
  return {
    async save(session) {
      sessions.set(session.token, session);
    },
    async get(token) {
      const session = sessions.get(token);
      if (!session || Date.parse(session.expiresAt) <= now()) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
    async complete(token, chatId) {
      const session = await this.get(token);
      if (!session) return null;
      const next: PairingSession = { ...session, status: "paired", chatId };
      sessions.set(token, next);
      return next;
    },
  };
}

function pairingKey(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("invalid pairing token");
  return `telegram:pair:${token}`;
}

function readSession(raw: string | null): PairingSession | null {
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as PairingSession;
    if (!session?.token || Date.parse(session.expiresAt) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}
