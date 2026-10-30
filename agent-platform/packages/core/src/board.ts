import type { ColumnMap, ExternalCard, Task } from "@agent-platform/shared";
import { newId, nowIso } from "@agent-platform/shared";
import { stageForColumn } from "./planning.js";
import { importStage } from "./workflow.js";

export interface BoardClient {
  listCards(): Promise<ExternalCard[]>;
  moveCard(externalId: string, columnName: string): Promise<void>;
}

export interface MergeResult {
  tasks: Task[];
  approvals: { taskId: string; reason: string }[];
  notices: { taskId: string; message: string }[];
}

export function mergeCards(agentId: string, tasks: Task[], cards: ExternalCard[], columns: ColumnMap, now = nowIso()): MergeResult {
  const next = tasks.map((task) => ({ ...task }));
  const approvals: MergeResult["approvals"] = [];
  const notices: MergeResult["notices"] = [];
  for (const card of cards) {
    if (!card.columnName.trim()) continue;
    const remote = stageForColumn(columns, card.columnName);
    if (!remote) {
      notices.push({ taskId: "", message: `column ${card.columnName} is not mapped` });
      continue;
    }
    const existing = next.find((task) => task.externalId === card.externalId);
    if (!existing) {
      const imported = importStage(remote, now);
      const task: Task = {
        id: newId(),
        agentId,
        externalId: card.externalId,
        title: card.title,
        description: card.description,
        acceptanceCriteria: card.acceptanceCriteria,
        comments: card.comments,
        url: card.url,
        stage: imported.stage,
        priority: card.priority,
        boardPosition: card.position ?? 0,
        estimateHours: null,
        dependsOn: [],
        dueAt: card.dueAt,
        plan: "",
        branchName: "",
        prUrl: "",
        blockedReason: "",
        exceptionNote: imported.exceptionNote,
        checksPassed: imported.checksPassed,
        labels: card.labels,
        createdAt: now,
        updatedAt: now,
      };
      next.push(task);
      if (imported.historicalApproval) approvals.push({ taskId: task.id, reason: "imported done card" });
      continue;
    }
    existing.title = card.title;
    existing.description = card.description;
    existing.acceptanceCriteria = card.acceptanceCriteria || existing.acceptanceCriteria;
    existing.comments = card.comments;
    existing.url = card.url || existing.url;
    existing.labels = card.labels;
    existing.dueAt = card.dueAt;
    if (typeof card.position === "number" && Number.isFinite(card.position)) existing.boardPosition = card.position;
    existing.updatedAt = now;
    if (remote === "done" && existing.stage === "review") {
      existing.stage = "done";
      approvals.push({ taskId: existing.id, reason: "board moved to done" });
      continue;
    }
    if (remote === "done" && existing.stage !== "done") {
      notices.push({
        taskId: existing.id,
        message: `${existing.title} is Done on the board before local review finished`,
      });
      continue;
    }
    // Review is only entered by the agent after Grill-me → Speckit → implement → push/PR.
    // Never trust the board for that promotion.
    if (remote === "review" && existing.stage !== "review" && existing.stage !== "done") {
      notices.push({
        taskId: existing.id,
        message: `${existing.title} was moved to Review on the board before the agent opened a PR`,
      });
      continue;
    }
    // Ghost Review cards (board-imported, no checks/PR) go back to To Do.
    if (existing.stage === "review" && !existing.checksPassed && !existing.prUrl) {
      existing.stage = "todo";
      existing.exceptionNote = existing.exceptionNote || "Returned to To Do: Review requires agent implementation and a pull request.";
      notices.push({
        taskId: existing.id,
        message: `${existing.title} left Review because it has no validated PR yet`,
      });
      continue;
    }
    // Keep local blocked/exception — board often still shows Doing, which would
    // otherwise restart a stall/checkout failure loop every poll.
    if (existing.stage === "blocked" || existing.stage === "exception") {
      continue;
    }
    if (existing.stage !== "done" && remote !== existing.stage) {
      existing.stage = remote;
    }
  }
  return { tasks: next, approvals, notices };
}
