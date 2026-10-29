import type { ModelAssignment, ModelRecord, ProviderRecord, UsageEntry } from "@agent-platform/shared";

const LIMIT = /\b(429|402)\b|budget exhausted|quota|rate limit|too many requests|insufficient[_\s-]?quota|out of (?:tokens|credits)|token limit|usage limit|payment required|credit balance|no tokens left|hit (?:its |the )?(?:token |usage )?limit/i;

export function isTokenLimitError(message: string): boolean {
  return LIMIT.test(message);
}

export interface PaidTokenReport {
  displayName: string;
  modelKey: string;
  providerName: string;
  activities: string[];
  used: number;
  budget: number | null;
  remaining: number | null;
  limitHit: boolean;
}

export function paidTokenReport(input: {
  agentId: string;
  assignments: ModelAssignment[];
  models: ModelRecord[];
  providers: ProviderRecord[];
  usage: UsageEntry[];
  limitRuns: { modelId: string; error: string }[];
}): PaidTokenReport[] {
  const relevant = input.assignments.filter((item) => item.agentId === null || item.agentId === input.agentId);
  const byModel = new Map<string, { activities: Set<string>; budget: number | null }>();
  for (const assignment of relevant) {
    const current = byModel.get(assignment.modelId) ?? { activities: new Set<string>(), budget: null };
    current.activities.add(assignment.activity);
    if (assignment.dailyTokenBudget !== null) {
      current.budget = current.budget === null ? assignment.dailyTokenBudget : Math.min(current.budget, assignment.dailyTokenBudget);
    }
    byModel.set(assignment.modelId, current);
  }
  const usedByKey = new Map<string, number>();
  for (const entry of input.usage) {
    if (entry.agentId !== input.agentId) continue;
    usedByKey.set(entry.modelId, (usedByKey.get(entry.modelId) ?? 0) + entry.tokensIn + entry.tokensOut);
  }
  const rows: PaidTokenReport[] = [];
  for (const model of input.models) {
    if (model.costClass !== "paid" || !model.enabled) continue;
    const assigned = byModel.get(model.id);
    const used = (usedByKey.get(model.id) ?? 0) + (usedByKey.get(model.modelId) ?? 0);
    if (!assigned && used === 0) continue;
    const provider = input.providers.find((item) => item.id === model.providerId);
    const budget = assigned?.budget ?? null;
    const limitHit = input.limitRuns.some((run) => isTokenLimitError(run.error) && (run.modelId === model.id || run.modelId === model.modelId));
    rows.push({
      displayName: model.displayName,
      modelKey: model.modelId,
      providerName: provider?.name ?? "provider",
      activities: [...(assigned?.activities ?? [])].sort(),
      used,
      budget,
      remaining: budget === null ? null : Math.max(0, budget - used),
      limitHit,
    });
  }
  return rows.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function describePaidTokens(agentName: string, rows: PaidTokenReport[]): string {
  if (rows.length === 0) return `${agentName} has no paid model in use.`;
  const lines = rows.map((row) => {
    const activities = row.activities.length > 0 ? row.activities.join(", ") : "earlier work";
    const cap = row.budget === null ? "No daily token cap is set." : `${row.remaining} tokens left of ${row.budget}.`;
    const hit = row.limitHit ? "The provider says this model has no tokens left or has hit its limit." : "";
    return [`${row.displayName} · ${row.providerName} · ${row.modelKey}`, `Used for ${activities}.`, `${row.used} tokens used today.`, cap, hit].filter(Boolean).join("\n");
  });
  return [`${agentName} paid models`, ...lines].join("\n\n");
}
