import type { Approval, Stage, Task } from "@agent-platform/shared";
import { nowIso } from "@agent-platform/shared";
import { WorkflowError } from "./errors.js";

const ALLOWED: Record<Stage, Stage[]> = {
  backlog: ["planning", "todo", "blocked", "failed"],
  planning: ["todo", "backlog", "blocked"],
  todo: ["doing", "planning", "backlog", "blocked"],
  doing: ["review", "blocked", "failed", "todo"],
  review: ["doing", "blocked"],
  done: [],
  blocked: ["todo", "doing", "planning", "backlog", "review"],
  failed: ["todo", "doing", "backlog"],
};

export interface TransitionContext {
  approval?: boolean;
  checksPassed?: boolean;
  exceptionNote?: string;
  reason?: string;
  now?: string;
}

export function assertTransition(from: Stage, to: Stage, ctx: TransitionContext = {}): void {
  if (from === to) return;
  if (to === "done") {
    if (from !== "review") throw new WorkflowError("done is only reachable from review");
    if (!ctx.approval) throw new WorkflowError("human approval is required before done");
    return;
  }
  if (to === "review") {
    if (!ctx.checksPassed && !ctx.exceptionNote) {
      throw new WorkflowError("validation must pass or an exception must be documented");
    }
  }
  if (!ALLOWED[from].includes(to)) throw new WorkflowError(`cannot move from ${from} to ${to}`);
}

export function transitionTask(task: Task, to: Stage, ctx: TransitionContext = {}): Task {
  assertTransition(task.stage, to, ctx);
  return {
    ...task,
    stage: to,
    checksPassed: ctx.checksPassed ?? task.checksPassed,
    exceptionNote: ctx.exceptionNote ?? task.exceptionNote,
    blockedReason: to === "blocked" ? ctx.reason ?? task.blockedReason : to === "doing" ? "" : task.blockedReason,
    updatedAt: ctx.now ?? nowIso(),
  };
}

export function approveTask(task: Task, _approval: Pick<Approval, "source">, now = nowIso()): Task {
  if (task.stage !== "review") throw new WorkflowError("only review tasks can be approved");
  return transitionTask(task, "done", { approval: true, now });
}

export function rejectTask(task: Task, reason: string, now = nowIso()): Task {
  if (task.stage !== "review") throw new WorkflowError("only review tasks can be rejected");
  return transitionTask(task, "doing", { reason, now, checksPassed: false });
}

export function importStage(stage: Stage, _now: string): Pick<Task, "stage" | "checksPassed" | "exceptionNote"> & { historicalApproval: boolean } {
  if (stage === "done") {
    return { stage: "done", checksPassed: false, exceptionNote: "Imported as already done on the board.", historicalApproval: true };
  }
  if (stage === "review") {
    return {
      stage: "review",
      checksPassed: false,
      exceptionNote: "Imported from the board while already in review.",
      historicalApproval: false,
    };
  }
  return { stage, checksPassed: false, exceptionNote: "", historicalApproval: false };
}

export function assertCanPushDone(hasApproval: boolean): void {
  if (!hasApproval) throw new WorkflowError("refusing to push done without approval");
}
