import path from "node:path";
import type { Agent } from "@agent-platform/shared";

export interface Checkout {
  role: "primary" | "secondary";
  name: string;
  url: string;
  directory: string;
  host: "github" | "gitlab";
  apiOrigin: string;
}

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepositoryRef(
  input: string,
  fallbackHost: "github" | "gitlab" = "github",
  fallbackOrigin = "",
): { name: string; url: string; host: "github" | "gitlab"; apiOrigin: string } | null {
  const trimmed = input.trim().replace(/\.git$/i, "");
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().includes("gitlab") ? "gitlab" : "github";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !OWNER_NAME.test(`${parts[0]}/${parts[1]}`)) return null;
    const name = `${parts[0]}/${parts[1]}`;
    const origin = `${parsed.protocol}//${parsed.host}`;
    return {
      name,
      url: `${origin}/${name}.git`,
      host,
      apiOrigin: host === "github" && parsed.hostname === "github.com" ? "https://api.github.com" : origin,
    };
  }
  if (!OWNER_NAME.test(trimmed)) return null;
  const host = fallbackHost;
  const origin = fallbackOrigin || (host === "gitlab" ? "https://gitlab.com" : "https://github.com");
  return {
    name: trimmed,
    url: `${origin}/${trimmed}.git`,
    host,
    apiOrigin: host === "github" ? "https://api.github.com" : origin,
  };
}

export function workspaceCheckouts(agent: Pick<Agent, "repositoryName" | "repositoryUrl" | "linkedRepositories">): Checkout[] {
  const primaryUrl = agent.repositoryUrl.trim();
  const primaryHint = parseRepositoryRef(primaryUrl) ?? parseRepositoryRef(agent.repositoryName);
  const fallbackHost = primaryHint?.host ?? "github";
  const fallbackOrigin = primaryHint?.host === "gitlab" ? new URL(primaryHint.url).origin : "";
  const linked = (agent.linkedRepositories ?? [])
    .map((item) => parseRepositoryRef(item, fallbackHost, fallbackOrigin))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const multi = linked.length > 0;
  const checkouts: Checkout[] = [];
  if (agent.repositoryName.trim() || primaryUrl) {
    const parsed = parseRepositoryRef(agent.repositoryName, fallbackHost, fallbackOrigin) ?? primaryHint;
    checkouts.push({
      role: "primary",
      name: parsed?.name || agent.repositoryName.trim(),
      url: multi ? (primaryUrl || parsed?.url || "") : primaryUrl,
      directory: multi ? "repo-primary" : "",
      host: parsed?.host ?? fallbackHost,
      apiOrigin: parsed?.apiOrigin ?? (fallbackHost === "gitlab" ? "https://gitlab.com" : "https://api.github.com"),
    });
  }
  for (const [index, repo] of linked.entries()) {
    if (checkouts.some((item) => item.name.toLowerCase() === repo.name.toLowerCase())) continue;
    checkouts.push({
      role: "secondary",
      name: repo.name,
      url: repo.url,
      directory: index === 0 ? "repo-secondary" : `repo-secondary-${index + 1}`,
      host: repo.host,
      apiOrigin: repo.apiOrigin,
    });
  }
  return checkouts;
}

export function checkoutPath(workspace: string, directory: string): string {
  return directory ? path.join(workspace, directory) : workspace;
}

export function containerWorkdir(workspace: string, hostCwd: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(hostCwd));
  if (!relative || relative === ".") return "/app/workspace";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return `/app/workspace/${relative.split(path.sep).join("/")}`;
}

export function containerCloneEnv(checkouts: Checkout[]): Record<string, string> {
  const primary = checkouts.find((checkout) => checkout.role === "primary" && checkout.directory && checkout.url);
  const secondary = checkouts.filter((checkout) => checkout.role === "secondary" && checkout.url);
  const env: Record<string, string> = {};
  if (primary) env.PRIMARY_REPO_URL = primary.url;
  if (secondary.length > 0) env.SECONDARY_REPO_URLS = secondary.map((checkout) => checkout.url).join(" ");
  return env;
}
