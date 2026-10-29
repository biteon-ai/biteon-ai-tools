export interface ChangeTarget {
  name: string;
  host: "github" | "gitlab";
  apiOrigin: string;
}

export interface OpenedChange {
  name: string;
  url: string;
}

type FetchLike = typeof fetch;

export async function openLinkedChanges(input: {
  token: string;
  targets: ChangeTarget[];
  head: string;
  base: string;
  title: string;
  ticket: string;
  ticketUrl: string;
  fetchImpl?: FetchLike;
}): Promise<OpenedChange[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const opened: OpenedChange[] = [];
  for (const target of input.targets) {
    const body = changeBody(input.ticket, input.ticketUrl, input.targets.map((item) => ({ name: item.name })));
    const url = await openChange(input.token, target, input.head, input.base, input.title, body, fetchImpl);
    if (url) opened.push({ name: target.name, url });
  }
  if (opened.length > 1) {
    const body = changeBody(input.ticket, input.ticketUrl, opened);
    await Promise.all(opened.map(async (change) => {
      const target = input.targets.find((item) => item.name === change.name);
      if (!target) return;
      await updateChangeBody(input.token, target, change.url, body, fetchImpl).catch(() => undefined);
    }));
  }
  return opened;
}

export function changeBody(ticket: string, ticketUrl: string, related: { name: string; url?: string }[]): string {
  const lines = [`Ticket: ${ticket}`];
  if (ticketUrl) lines.push(`Board: ${ticketUrl}`);
  lines.push("", "Related repositories for this ticket:");
  for (const item of related) lines.push(item.url ? `- ${item.name}: ${item.url}` : `- ${item.name}`);
  return lines.join("\n");
}

async function openChange(token: string, target: ChangeTarget, head: string, base: string, title: string, body: string, fetchImpl: FetchLike): Promise<string> {
  if (target.host === "gitlab") return openGitlabMergeRequest(token, target, head, base, title, body, fetchImpl);
  return openGithubPullRequest(token, target.name, head, base, title, body, fetchImpl);
}

async function updateChangeBody(token: string, target: ChangeTarget, url: string, body: string, fetchImpl: FetchLike): Promise<void> {
  if (target.host === "gitlab") {
    const id = url.match(/merge_requests\/(\d+)/)?.[1];
    if (!id) return;
    const response = await fetchImpl(`${gitlabApi(target.apiOrigin)}/projects/${encodeURIComponent(target.name)}/merge_requests/${id}`, {
      method: "PUT",
      headers: gitlabHeaders(token),
      body: JSON.stringify({ description: body }),
    });
    if (!response.ok) throw new Error(`GitLab merge request update failed with status ${response.status}`);
    return;
  }
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  if (!number) return;
  const response = await fetchImpl(`${githubApi(target.apiOrigin)}/repos/${target.name}/pulls/${number}`, {
    method: "PATCH",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub pull request update failed with status ${response.status}`);
}

async function openGithubPullRequest(token: string, repository: string, head: string, base: string, title: string, body: string, fetchImpl: FetchLike): Promise<string> {
  const api = "https://api.github.com";
  const response = await fetchImpl(`${api}/repos/${repository}/pulls`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ title, head, base, body }),
  });
  if (response.status === 422) {
    const existing = await fetchImpl(`${api}/repos/${repository}/pulls?head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`, {
      headers: githubHeaders(token),
    });
    if (existing.ok) {
      const pulls = await existing.json() as Array<{ html_url?: string }>;
      if (pulls[0]?.html_url) return pulls[0].html_url;
    }
  }
  if (!response.ok) throw new Error(`GitHub pull request failed with status ${response.status}`);
  const payload = await response.json() as { html_url?: string };
  return payload.html_url ?? "";
}

async function openGitlabMergeRequest(token: string, target: ChangeTarget, head: string, base: string, title: string, body: string, fetchImpl: FetchLike): Promise<string> {
  const project = encodeURIComponent(target.name);
  const response = await fetchImpl(`${gitlabApi(target.apiOrigin)}/projects/${project}/merge_requests`, {
    method: "POST",
    headers: gitlabHeaders(token),
    body: JSON.stringify({ source_branch: head, target_branch: base, title, description: body }),
  });
  if (response.status === 409 || response.status === 422) {
    const existing = await fetchImpl(`${gitlabApi(target.apiOrigin)}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}&state=opened`, {
      headers: gitlabHeaders(token),
    });
    if (existing.ok) {
      const requests = await existing.json() as Array<{ web_url?: string }>;
      if (requests[0]?.web_url) return requests[0].web_url;
    }
  }
  if (!response.ok) throw new Error(`GitLab merge request failed with status ${response.status}`);
  const payload = await response.json() as { web_url?: string };
  return payload.web_url ?? "";
}

export async function mergeApprovedChanges(input: {
  token: string;
  urls: string[];
  base?: string;
  fetchImpl?: FetchLike;
}): Promise<{ base: string; urls: string[] }> {
  const base = input.base || "develop";
  const fetchImpl = input.fetchImpl ?? fetch;
  const changes = input.urls.map(parseChangeUrl).filter((change): change is ChangeRef => Boolean(change));
  if (changes.length === 0) throw new Error("The pull request link could not be read.");
  for (const change of changes) {
    if (change.host === "gitlab") await mergeGitlabRequest(input.token, change, base, fetchImpl);
    else await mergeGithubRequest(input.token, change, base, fetchImpl);
  }
  return { base, urls: changes.map((change) => change.url) };
}

export function parseChangeUrl(raw: string): ChangeRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const pull = parts.lastIndexOf("pull");
  if (pull > 1 && parts[pull + 1] && /^\d+$/.test(parts[pull + 1])) {
    return { host: "github", apiOrigin: url.origin, name: parts.slice(0, pull).join("/"), number: parts[pull + 1], url: raw };
  }
  const request = parts.lastIndexOf("merge_requests");
  const dash = parts.lastIndexOf("-");
  if (request > 0 && parts[request + 1] && /^\d+$/.test(parts[request + 1])) {
    const nameEnd = dash > 0 && dash < request ? dash : request;
    return { host: "gitlab", apiOrigin: url.origin, name: parts.slice(0, nameEnd).join("/"), number: parts[request + 1], url: raw };
  }
  return null;
}

interface ChangeRef {
  host: "github" | "gitlab";
  apiOrigin: string;
  name: string;
  number: string;
  url: string;
}

async function mergeGithubRequest(token: string, change: ChangeRef, base: string, fetchImpl: FetchLike): Promise<void> {
  const api = `${githubApi(change.apiOrigin)}/repos/${change.name}/pulls/${change.number}`;
  const current = await fetchImpl(api, { headers: githubHeaders(token) });
  if (!current.ok) throw new Error(`GitHub pull request could not be read (${current.status}).`);
  const payload = await current.json() as { merged?: boolean; base?: { ref?: string } };
  if (payload.merged) return;
  if (payload.base?.ref !== base) {
    const patched = await fetchImpl(api, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ base }) });
    if (!patched.ok) throw new Error(`The pull request could not be retargeted to ${base} (${patched.status}).`);
  }
  const merged = await fetchImpl(`${api}/merge`, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify({ merge_method: "merge", commit_title: `Merge pull request #${change.number} into ${base}` }),
  });
  if (!merged.ok) throw new Error(`GitHub did not merge the pull request into ${base} (${merged.status}).`);
}

async function mergeGitlabRequest(token: string, change: ChangeRef, base: string, fetchImpl: FetchLike): Promise<void> {
  const api = `${gitlabApi(change.apiOrigin)}/projects/${encodeURIComponent(change.name)}/merge_requests/${change.number}`;
  const current = await fetchImpl(api, { headers: gitlabHeaders(token) });
  if (!current.ok) throw new Error(`GitLab merge request could not be read (${current.status}).`);
  const payload = await current.json() as { state?: string; target_branch?: string };
  if (payload.state === "merged") return;
  if (payload.target_branch !== base) {
    const patched = await fetchImpl(api, { method: "PUT", headers: gitlabHeaders(token), body: JSON.stringify({ target_branch: base }) });
    if (!patched.ok) throw new Error(`The merge request could not be retargeted to ${base} (${patched.status}).`);
  }
  const merged = await fetchImpl(`${api}/merge`, { method: "PUT", headers: gitlabHeaders(token), body: JSON.stringify({}) });
  if (!merged.ok) throw new Error(`GitLab did not merge the merge request into ${base} (${merged.status}).`);
}

function githubApi(origin: string): string {
  return origin === "https://api.github.com" || origin === "https://github.com" ? "https://api.github.com" : `${origin.replace(/\/$/, "")}/api/v3`;
}

function gitlabApi(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/v4`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agent-platform",
    accept: "application/vnd.github+json",
  };
}

function gitlabHeaders(token: string): Record<string, string> {
  return {
    "PRIVATE-TOKEN": token,
    "content-type": "application/json",
    "user-agent": "agent-platform",
  };
}
