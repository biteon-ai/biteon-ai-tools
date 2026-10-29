import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 8) return "configured";
  return `••••${trimmed.slice(-4)}`;
}

export function encryptSecret(plaintext: string, masterKey: string): { ciphertext: string; iv: string; authTag: string } {
  if (masterKey.length < 32) throw new Error("master key must be at least 32 characters");
  const key = createHash("sha256").update(masterKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(payload: { ciphertext: string; iv: string; authTag: string }, masterKey: string): string {
  const key = createHash("sha256").update(masterKey).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== hash.length) return false;
  return timingSafeEqual(hash, expected);
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
