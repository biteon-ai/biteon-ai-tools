import type { ExternalCard } from "@agent-platform/shared";
import { redact } from "@agent-platform/core";

type FetchLike = typeof fetch;

interface GraphqlError { message?: string }
interface GraphqlResponse<T> { data?: T; errors?: GraphqlError[] }

export async function githubGraphql<T>(token: string, query: string, variables: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<T> {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agent-platform",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`);
  const body = await response.json() as GraphqlResponse<T>;
  if (body.errors?.length) throw new Error(redact(body.errors.map((error) => error.message ?? "GitHub error").join("; ")));
  if (!body.data) throw new Error("GitHub response did not include data");
  return body.data;
}

export async function listGithubProjects(token: string, owner: string, name: string, fetchImpl?: FetchLike): Promise<{ id: string; title: string; number: number }[]> {
  const data = await githubGraphql<{ repository?: { projectsV2?: { nodes?: { id: string; title: string; number: number }[] } } }>(
    token,
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        projectsV2(first: 20) { nodes { id title number } }
      }
    }`,
    { owner, name },
    fetchImpl,
  );
  return data.repository?.projectsV2?.nodes ?? [];
}

interface ProjectItemNode {
  id: string;
  content?: { title?: string; body?: string; url?: string; number?: number } | null;
  fieldValues?: { nodes?: Array<{ name?: string; field?: { name?: string } | null }> };
}

export function parseProjectItems(nodes: ProjectItemNode[], statusFieldName = "Status"): ExternalCard[] {
  return nodes.map((node, index) => {
    const status = node.fieldValues?.nodes?.find((value) => value.field?.name === statusFieldName)?.name ?? "";
    return {
      externalId: node.id,
      title: node.content?.title ?? "Untitled",
      description: node.content?.body ?? "",
      acceptanceCriteria: "",
      columnName: status,
      url: node.content?.url ?? "",
      comments: [],
      labels: [],
      dueAt: null,
      priority: 3,
      position: index,
    };
  });
}

export async function listGithubProjectCards(token: string, projectId: string, fetchImpl?: FetchLike): Promise<{ cards: ExternalCard[]; statusFieldId: string; options: { id: string; name: string }[] }> {
  const data = await githubGraphql<{
    node?: {
      title?: string;
      fields?: { nodes?: Array<{ id?: string; name?: string; options?: { id: string; name: string }[] }> };
      items?: { nodes?: ProjectItemNode[] };
    };
  }>(
    token,
    `query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          title
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
          items(first: 50) {
            nodes {
              id
              content { ... on Issue { title body url number } ... on DraftIssue { title body } }
              fieldValues(first: 20) {
                nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } }
              }
            }
          }
        }
      }
    }`,
    { id: projectId },
    fetchImpl,
  );
  const fields = data.node?.fields?.nodes ?? [];
  const status = fields.find((field) => field.name === "Status" && field.options);
  return {
    cards: parseProjectItems(data.node?.items?.nodes ?? []),
    statusFieldId: status?.id ?? "",
    options: status?.options ?? [],
  };
}

export async function moveGithubProjectCard(token: string, projectId: string, itemId: string, fieldId: string, optionId: string, fetchImpl?: FetchLike): Promise<void> {
  await githubGraphql(
    token,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId, fieldId, optionId },
    fetchImpl,
  );
}

export async function openPullRequest(token: string, repository: string, head: string, base: string, title: string, body: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agent-platform",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title, head, base, body }),
  });
  if (response.status === 422) {
    const existing = await fetchImpl(`https://api.github.com/repos/${repository}/pulls?head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "agent-platform", accept: "application/vnd.github+json" },
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
