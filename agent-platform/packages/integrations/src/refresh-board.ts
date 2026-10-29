import { mergeCards } from "@agent-platform/core";
import { newId, nowIso, type Agent, type Approval, type Task, type Workflow } from "@agent-platform/shared";
import { createBoardClient } from "./board-factory.js";

export interface BoardRefreshStore {
  listTasks(agentId: string): Promise<Task[]>;
  saveTask(task: Task): Promise<unknown>;
  getWorkflow(agentId: string): Promise<Workflow | null>;
  createApproval(approval: Approval): Promise<unknown>;
}

export async function refreshStoredBoard(
  store: BoardRefreshStore,
  agent: Agent,
  credentials: { key: string; token: string },
  fetchImpl?: typeof fetch,
): Promise<{ tasks: Task[]; boardError: string | null; notices: { taskId: string; message: string }[] }> {
  const local = await store.listTasks(agent.id);
  if (agent.provider === "none" || !agent.boardId) return { tasks: local, boardError: null, notices: [] };
  if (!credentials.token) return { tasks: local, boardError: "Board credentials are not configured.", notices: [] };
  if (agent.provider === "trello" && !credentials.key) {
    return { tasks: local, boardError: "Trello needs the API key and token saved together as JSON before tickets can be loaded.", notices: [] };
  }
  const workflow = await store.getWorkflow(agent.id);
  const board = workflow ? createBoardClient({ provider: agent.provider, boardId: agent.boardId, credentials, fetchImpl }) : null;
  if (!board || !workflow) return { tasks: local, boardError: "Board credentials are not configured.", notices: [] };
  try {
    const merged = mergeCards(agent.id, local, await board.listCards(), workflow.columns);
    for (const task of merged.tasks) await store.saveTask(task);
    for (const approval of merged.approvals) {
      await store.createApproval({
        id: newId(),
        taskId: approval.taskId,
        agentId: agent.id,
        source: approval.reason.includes("imported") ? "import" : "board",
        decision: "approved",
        actor: "board",
        comment: approval.reason,
        createdAt: nowIso(),
      });
    }
    const unmapped = [...new Set(merged.notices.filter((notice) => notice.message.startsWith("column ")).map((notice) => notice.message.replace(/^column /, "").replace(/ is not mapped$/, "").trim()).filter(Boolean))];
    const boardError = unmapped.length > 0 && merged.tasks.length === local.length
      ? `These board columns are not mapped yet: ${unmapped.join(", ")}.`
      : null;
    return { tasks: await store.listTasks(agent.id), boardError, notices: merged.notices };
  } catch {
    return { tasks: local, boardError: "The board did not return its tickets.", notices: [] };
  }
}
