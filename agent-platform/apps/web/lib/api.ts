export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
  if (response.status === 401 && !path.startsWith("/api/auth/login")) {
    window.location.href = "/login";
    throw new Error("authentication required");
  }
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
