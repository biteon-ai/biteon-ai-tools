import { SignJWT, jwtVerify } from "jose";

export async function signSession(userId: string, email: string, secret: string): Promise<string> {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(secret));
}

export async function verifySession(token: string, secret: string): Promise<{ userId: string; email: string }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
  if (!payload.sub || typeof payload.email !== "string") throw new Error("session missing subject");
  return { userId: payload.sub, email: payload.email };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = ["session=", "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
