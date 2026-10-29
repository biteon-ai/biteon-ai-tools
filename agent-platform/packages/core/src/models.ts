import type { Activity, CostClass, ModelAssignment, ModelRecord, ProviderRecord, ProviderType } from "@agent-platform/shared";
import { ConfigError } from "./errors.js";

const PAID_TYPES = new Set<ProviderType>(["openai", "anthropic", "cursor", "codex"]);

export function assertCostClass(type: ProviderType, costClass: CostClass): void {
  if (type === "ollama" && costClass !== "local") {
    throw new ConfigError("Ollama models must use the local cost class");
  }
  if (PAID_TYPES.has(type) && costClass !== "paid") {
    throw new ConfigError(`${type} providers are paid and cannot be labeled ${costClass}`);
  }
  if (type !== "ollama" && type !== "custom" && costClass === "local") {
    throw new ConfigError("only Ollama and custom providers can use the local cost class");
  }
}

export function findProviderMatch(
  existing: ProviderRecord[],
  candidate: Pick<ProviderRecord, "name" | "type"> & { id?: string },
): ProviderRecord | undefined {
  const name = candidate.name.trim().toLowerCase();
  return existing.find((item) => {
    if (candidate.id && item.id === candidate.id) return false;
    if (item.name.trim().toLowerCase() === name) return true;
    return candidate.type !== "custom" && item.type === candidate.type;
  });
}

export function findDuplicateModel(
  existing: ModelRecord[],
  candidate: Pick<ModelRecord, "providerId" | "modelId" | "displayName"> & { id?: string },
): ModelRecord | undefined {
  const modelId = candidate.modelId.trim().toLowerCase();
  const name = candidate.displayName.trim().toLowerCase();
  return existing.find((item) => {
    if (candidate.id && item.id === candidate.id) return false;
    if (item.providerId !== candidate.providerId) return false;
    return item.modelId.trim().toLowerCase() === modelId || item.displayName.trim().toLowerCase() === name;
  });
}

export function assertAssignment(assignment: Pick<ModelAssignment, "allowLocalOnly" | "requirePaid">): void {
  if (assignment.allowLocalOnly && assignment.requirePaid) {
    throw new ConfigError("an activity cannot both require a paid model and allow only local models");
  }
}

export interface ResolvedRoute {
  model: ModelRecord;
  provider: ProviderRecord;
}

export function routeModel(input: {
  activity: Activity;
  agentId: string;
  assignments: ModelAssignment[];
  models: ModelRecord[];
  providers: ProviderRecord[];
  usageTokensByModel: Record<string, number>;
}): ResolvedRoute | { error: string } {
  const assignment =
    input.assignments.find((item) => item.activity === input.activity && item.agentId === input.agentId) ??
    input.assignments.find((item) => item.activity === input.activity && item.agentId === null);
  if (!assignment) return { error: `no model assigned for ${input.activity}` };
  const chain = [assignment.modelId, assignment.fallbackModelId].filter((id): id is string => Boolean(id));
  const skipped: string[] = [];
  for (const id of chain) {
    const model = input.models.find((item) => item.id === id && item.enabled);
    if (!model) {
      skipped.push(`${id} missing`);
      continue;
    }
    const provider = input.providers.find((item) => item.id === model.providerId && item.enabled);
    if (!provider) {
      skipped.push(`${model.displayName} provider disabled`);
      continue;
    }
    if (assignment.allowLocalOnly && model.costClass !== "local") {
      skipped.push(`${model.displayName} is not local`);
      continue;
    }
    if (assignment.requirePaid && model.costClass !== "paid") {
      skipped.push(`${model.displayName} is not a paid model`);
      continue;
    }
    const used = input.usageTokensByModel[model.id] ?? 0;
    if (assignment.dailyTokenBudget !== null && used >= assignment.dailyTokenBudget) {
      skipped.push(`${model.displayName} budget exhausted`);
      continue;
    }
    return { model, provider };
  }
  return { error: skipped.join("; ") || "no model available in the fallback chain" };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export function executorForProvider(type: ProviderType): "llm" | "cursor" | "codex" {
  if (type === "cursor") return "cursor";
  if (type === "codex") return "codex";
  return "llm";
}
