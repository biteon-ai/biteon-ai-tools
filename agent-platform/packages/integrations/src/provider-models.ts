export interface RemoteModel {
  id: string;
  displayName: string;
}

const KEYED = new Set(["openai", "anthropic", "cursor", "codex"]);

export function modelCatalogUrl(type: string, baseUrl: string): string {
  if (type === "cursor") return "https://api.cursor.com/v1/models";
  if (type === "anthropic" && !baseUrl.trim()) return "https://api.anthropic.com/v1/models";
  if (type === "codex" && !baseUrl.trim()) return "https://api.openai.com/v1/models";
  return openAiModelsUrl(baseUrl);
}

export function readModelCatalog(payload: unknown): RemoteModel[] {
  const models: RemoteModel[] = [];
  const seen = new Set<string>();
  for (const row of catalogRows(payload)) {
    const id = textValue(row, ["id", "name", "model"]);
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    models.push({ id, displayName: textValue(row, ["displayName", "display_name", "name", "id"]) || id });
  }
  return models;
}

export async function listProviderModels(input: {
  type: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<RemoteModel[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (KEYED.has(input.type) && !input.apiKey.trim()) {
    throw new Error("Save an API key on this provider before loading its models");
  }
  const url = modelCatalogUrl(input.type, input.baseUrl);
  if (!url) throw new Error("This provider needs a base URL before its models can load");
  const first = await requestCatalog(fetchImpl, url, input.type, input.apiKey);
  if (first.models.length > 0 || input.type !== "ollama") {
    if (first.error) throw new Error(first.error);
    return first.models;
  }
  const tagsUrl = input.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "") + "/api/tags";
  const tags = await requestCatalog(fetchImpl, tagsUrl, input.type, input.apiKey);
  if (tags.error) throw new Error(tags.error);
  return tags.models;
}

function openAiModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/models")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

async function requestCatalog(fetchImpl: typeof fetch, url: string, type: string, apiKey: string): Promise<{ models: RemoteModel[]; error: string }> {
  try {
    const response = await fetchImpl(url, { headers: catalogHeaders(type, apiKey) });
    if (!response.ok) return { models: [], error: `Model list returned ${response.status}` };
    return { models: readModelCatalog(await response.json()), error: "" };
  } catch {
    return { models: [], error: "The provider did not respond" };
  }
}

function catalogHeaders(type: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey.trim()) return headers;
  if (type === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function catalogRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "data", "models"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function textValue(row: unknown, keys: string[]): string {
  if (typeof row === "string") return keys[0] === "id" || keys.includes("id") ? row.trim() : row.trim();
  if (!row || typeof row !== "object") return "";
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
