import type {
  Activity,
  Agent,
  Checkpoint,
  CodeExecutor,
  ExecutorModel,
  ExecutorResult,
  Memory,
  SchedulerState,
  Stage,
  Task,
  TaskRun,
  Workflow,
} from "@agent-platform/shared";
import { newId } from "@agent-platform/shared";
import type { BoardClient } from "./board.js";
import { mergeCards } from "./board.js";
import { backoffMinutes, branchName, chooseIntake, columnForStage, estimateHours, remainingCapacity } from "./planning.js";
import { buildTaskPrompt } from "./prompt.js";
import { workspaceCheckouts } from "./repositories.js";
import { evaluateQualityGates } from "./quality.js";
import type { NotificationDraft } from "./notify.js";
import { approveTask, assertCanPushDone, transitionTask } from "./workflow.js";

export interface GitClient {
  prepare(agent: Agent, task: Task, ownedFiles: string[]): Promise<{ branch: string; dirtyForeign: boolean }>;
  commitAndPush(agent: Agent, task: Task, ownedFiles: string[], message: string): Promise<{ prUrl: string }>;
  diff(agent: Agent): Promise<{ diff: string; files: string[] }>;
  conflictCheck(agent: Agent, baseBranch: string): Promise<{ clean: boolean; detail: string }>;
}

export interface TickDeps {
  now: Date;
  agent: Agent;
  workflow: Workflow;
  tasks: Task[];
  memories: Memory[];
  scheduler: SchedulerState;
  board: BoardClient | null;
  git: GitClient;
  executor: CodeExecutor;
  model?: ExecutorModel;
  activity?: Activity;
  notify: (draft: NotificationDraft) => Promise<void>;
  saveTask: (task: Task) => Promise<void>;
  saveScheduler: (state: SchedulerState) => Promise<void>;
  createRun: (run: TaskRun) => Promise<void>;
  updateRun: (run: TaskRun) => Promise<void>;
  saveCheckpoint: (checkpoint: Checkpoint) => Promise<void>;
  latestCheckpoint: (runId: string) => Promise<Checkpoint | null>;
  findRun: (runId: string) => Promise<TaskRun | null>;
  recordApproval: (taskId: string, source: "board" | "import", comment: string) => Promise<void>;
  runValidation: (commands: string[][]) => Promise<{ passed: boolean; detail: string }>;
  remember?: (input: { task: Task; phase: "start" | "review" | "failed"; note: string }) => Promise<Memory>;
}

export interface TickResult {
  action: string;
  taskId?: string;
  detail?: string;
}

export async function runAgentTick(deps: TickDeps): Promise<TickResult> {
  if (deps.agent.status !== "running") return { action: "idle", detail: deps.agent.status };
  const now = deps.now.toISOString();
  let tasks = deps.tasks.map((task) => ({ ...task }));
  if (deps.board) {
    const cards = await deps.board.listCards();
    const merged = mergeCards(deps.agent.id, tasks, cards, deps.workflow.columns, now);
    for (const approval of merged.approvals) {
      await deps.recordApproval(approval.taskId, approval.reason.includes("imported") ? "import" : "board", approval.reason);
    }
    for (const notice of merged.notices) {
      if (!notice.taskId) continue;
      await deps.notify({
        agentName: deps.agent.name,
        repository: deps.agent.repositoryName,
        severity: "warning",
        status: "sync",
        title: "Board sync needs attention",
        body: notice.message,
        action: "Review the board column before the agent continues.",
      });
    }
    tasks = merged.tasks;
    for (const task of tasks) await deps.saveTask(task);
  }

  const doing = tasks.filter((task) => task.stage === "doing");
  if (doing.length > 0) return continueTask(deps, tasks, doing[0]!);

  const remaining = remainingCapacity(deps.agent.dailyCapacityHours, tasks, deps.now);
  const intake = chooseIntake({
    tasks,
    remainingHours: remaining,
    allowOverCapacity: deps.agent.allowOverCapacity,
    maxTasksPerDay: deps.workflow.selection.maxTasksPerDay,
    blockedLabels: deps.workflow.selection.blockedLabels,
  });
  for (const deferred of intake.deferred) {
    deferred.task.plan = deferred.reason;
    await deps.saveTask(deferred.task);
  }
  for (const chosen of intake.promote) {
    let queued = chosen;
    if (queued.stage === "backlog") queued = transitionTask(queued, "planning", { now });
    if (queued.stage === "planning") queued = transitionTask(queued, "todo", { now });
    queued.estimateHours = queued.estimateHours ?? estimateHours(queued);
    queued.plan = `Selected from Backlog within ${remaining}h remaining capacity.`;
    await deps.saveTask(queued);
    await push(deps, queued, "todo");
    replaceTask(tasks, queued);
  }
  deps.scheduler.lastPlanAt = now;
  await deps.saveScheduler(deps.scheduler);
  if (!intake.start) return { action: "planned", detail: intake.detail };
  return startTask(deps, tasks, intake.start);
}

async function continueTask(deps: TickDeps, tasks: Task[], task: Task): Promise<TickResult> {
  const now = deps.now;
  const run = deps.scheduler.activeRunId ? await deps.findRun(deps.scheduler.activeRunId) : null;
  if (run?.status === "running") {
    const checkpoint = await deps.latestCheckpoint(run.id);
    const updated = Date.parse(checkpoint?.createdAt ?? run.startedAt);
    const stalled = now.getTime() - updated > deps.agent.rules.stallMinutes * 60 * 1000;
    if (stalled) {
      const blocked = transitionTask(task, "blocked", { now: now.toISOString(), reason: "stalled with no checkpoint progress" });
      await deps.saveTask(blocked);
      run.status = "failed";
      run.error = blocked.blockedReason;
      run.finishedAt = now.toISOString();
      await deps.updateRun(run);
      deps.scheduler.activeRunId = null;
      await deps.saveScheduler(deps.scheduler);
      await deps.notify(draft(deps, blocked, "urgent", "Task stalled", "The run made no progress before the stall window.", "Inspect the checkpoint and resume or reject the approach."));
      return { action: "blocked", taskId: blocked.id, detail: "stalled" };
    }
    return execute(deps, tasks, task, run, checkpoint);
  }
  if (run?.status === "failed") {
    if (deps.scheduler.retryAt && now.getTime() < Date.parse(deps.scheduler.retryAt)) {
      return { action: "waiting", taskId: task.id, detail: "backoff" };
    }
    if (deps.scheduler.consecutiveFailures >= deps.agent.rules.maxRetries) {
      const blocked = transitionTask(task, "blocked", { now: now.toISOString(), reason: "retry budget exhausted" });
      await deps.saveTask(blocked);
      await deps.notify(draft(deps, blocked, "urgent", "Retry budget exhausted", run.error || "The executor failed repeatedly.", "Change the task or the model assignment before resuming."));
      return { action: "blocked", taskId: blocked.id, detail: "retries exhausted" };
    }
  }
  return startTask(deps, tasks, task, true);
}

async function startTask(deps: TickDeps, tasks: Task[], original: Task, alreadyDoing = false): Promise<TickResult> {
  const current = tasks.find((task) => task.id === original.id) ?? original;
  const now = deps.now.toISOString();
  let task = current;
  if (!alreadyDoing) {
    task = transitionTask(task.stage === "todo" ? task : transitionTask(task, "todo", { now }), "doing", { now });
  }
  task.branchName = task.branchName || branchName(deps.agent.rules.branchPattern, task);
  task.estimateHours = task.estimateHours ?? estimateHours(task);
  await deps.saveTask(task);
  await push(deps, task, "doing");
  const run: TaskRun = {
    id: newId(),
    taskId: task.id,
    agentId: deps.agent.id,
    executorId: deps.executor.id,
    status: "running",
    activity: deps.activity ?? "coding",
    modelId: "",
    costClass: "none",
    summary: "",
    error: "",
    tokensIn: 0,
    tokensOut: 0,
    startedAt: now,
    finishedAt: null,
  };
  await deps.createRun(run);
  deps.scheduler.activeRunId = run.id;
  deps.scheduler.lastTickAt = now;
  await deps.saveScheduler(deps.scheduler);
  await deps.notify(draft(deps, task, "info", "Task started", "Implementation started.", undefined));
  const checkpoint = await deps.latestCheckpoint(run.id);
  return execute(deps, tasks, task, run, checkpoint);
}

async function execute(deps: TickDeps, _tasks: Task[], task: Task, run: TaskRun, checkpoint: Checkpoint | null): Promise<TickResult> {
  const prepared = await deps.git.prepare(deps.agent, task, checkpoint?.ownedFiles ?? []);
  if (prepared.dirtyForeign) {
    const blocked = transitionTask(task, "blocked", { now: deps.now.toISOString(), reason: "workspace has changes the agent does not own" });
    await deps.saveTask(blocked);
    run.status = "failed";
    run.error = blocked.blockedReason;
    run.finishedAt = deps.now.toISOString();
    await deps.updateRun(run);
    deps.scheduler.activeRunId = null;
    deps.scheduler.consecutiveFailures += 1;
    await deps.saveScheduler(deps.scheduler);
    await deps.notify(draft(deps, blocked, "urgent", "Foreign changes detected", blocked.blockedReason, "Clean up or claim the unexpected files before the agent continues."));
    return { action: "blocked", taskId: task.id, detail: "dirty workspace" };
  }
  task.branchName = prepared.branch;
  const checkouts = workspaceCheckouts(deps.agent);
  const started = await rememberBuild(deps, task, "start", task.plan || "");
  const memories = started ? [started, ...deps.memories.filter((memory) => memory.id !== started.id)] : deps.memories;
  const prompt = buildTaskPrompt({
    agentName: deps.agent.name,
    repository: checkouts.map((checkout) => checkout.name).filter(Boolean).join(", ") || deps.agent.repositoryName || deps.agent.repositoryUrl,
    task,
    memories,
    rules: deps.agent.rules,
    checkouts,
  });
  let result: ExecutorResult;
  try {
    result = await deps.executor.run({
      runId: run.id,
      agentId: deps.agent.id,
      taskId: task.id,
      workspaceDir: deps.agent.workspacePath,
      prompt,
      model: deps.model ?? {
        id: "unassigned",
        modelId: "unassigned",
        costClass: "local",
        baseUrl: "",
        apiKey: "",
        providerType: "custom",
      },
      limits: { timeoutMs: 120000, maxSteps: 8, maxTokens: 4000 },
      checkpoint: checkpoint
        ? { step: checkpoint.step, note: checkpoint.note, ownedFiles: checkpoint.ownedFiles }
        : null,
    });
  } catch (error) {
    result = {
      status: "error",
      summary: "executor failed to start",
      tokensIn: 0,
      tokensOut: 0,
      modelId: "",
      costClass: "none",
      checkpoint: checkpoint ? { step: checkpoint.step, note: checkpoint.note, ownedFiles: checkpoint.ownedFiles } : null,
      error: error instanceof Error ? error.message : "executor failed",
    };
  }
  if (result.checkpoint) {
    await deps.saveCheckpoint({
      id: newId(),
      taskRunId: run.id,
      agentId: deps.agent.id,
      step: result.checkpoint.step,
      note: result.checkpoint.note,
      ownedFiles: result.checkpoint.ownedFiles,
      createdAt: deps.now.toISOString(),
    });
  }
  run.modelId = result.modelId;
  run.costClass = result.costClass;
  run.tokensIn = result.tokensIn;
  run.tokensOut = result.tokensOut;
  run.summary = result.summary;
  run.finishedAt = deps.now.toISOString();
  if (result.status !== "succeeded") {
    run.status = result.status === "cancelled" ? "cancelled" : "failed";
    run.error = result.error || result.summary;
    await deps.updateRun(run);
    deps.scheduler.consecutiveFailures += 1;
    deps.scheduler.retryAt = new Date(deps.now.getTime() + backoffMinutes(deps.scheduler.consecutiveFailures) * 60000).toISOString();
    deps.scheduler.activeRunId = run.id;
    await deps.saveScheduler(deps.scheduler);
    await deps.saveTask(task);
    await deps.notify(draft(deps, task, "warning", "Execution failed", run.error, "The agent will retry until the retry budget is exhausted."));
    await rememberBuild(deps, task, "failed", run.error);
    return { action: "failed", taskId: task.id, detail: run.error };
  }
  const owned = result.checkpoint?.ownedFiles ?? [];
  const changes = await deps.git.diff(deps.agent);
  const validation = await deps.runValidation(deps.agent.rules.validationCommands);
  const conflict = await deps.git.conflictCheck(deps.agent, deps.agent.defaultBranch || "develop");
  const gates = evaluateQualityGates({
    diff: changes.diff,
    files: changes.files,
    skills: deps.agent.rules.skills,
    validationPassed: validation.passed,
    validationDetail: validation.detail,
    allowEmptyChecks: deps.agent.rules.allowEmptyChecks,
    commandsConfigured: deps.agent.rules.validationCommands.length > 0,
  });
  if (!gates.ok) {
    run.status = "failed";
    run.error = gates.blocking.join("; ");
    await deps.updateRun(run);
    deps.scheduler.consecutiveFailures += 1;
    deps.scheduler.retryAt = new Date(deps.now.getTime() + backoffMinutes(deps.scheduler.consecutiveFailures) * 60000).toISOString();
    await deps.saveScheduler(deps.scheduler);
    await deps.saveTask(task);
    await deps.notify(draft(deps, task, "warning", "Validation failed", run.error, "Fix the reported checks. The task stays in Doing."));
    await rememberBuild(deps, task, "failed", run.error);
    return { action: "failed", taskId: task.id, detail: run.error };
  }
  if (!validation.passed || !conflict.clean) {
    const detail = !validation.passed
      ? validation.detail || "validation commands did not exit 0"
      : conflict.detail || "git conflict dry-run failed";
    run.status = "failed";
    run.error = detail;
    await deps.updateRun(run);
    deps.scheduler.consecutiveFailures += 1;
    deps.scheduler.retryAt = new Date(deps.now.getTime() + backoffMinutes(deps.scheduler.consecutiveFailures) * 60000).toISOString();
    await deps.saveScheduler(deps.scheduler);
    await deps.saveTask(task);
    await deps.notify(draft(deps, task, "warning", "Review blocked", detail, "The conflict dry-run and every validation command must exit 0 before Review."));
    await rememberBuild(deps, task, "failed", detail);
    return { action: "failed", taskId: task.id, detail };
  }
  const committed = await deps.git.commitAndPush(
    deps.agent,
    task,
    owned,
    `${task.title} (task ${task.externalId})`,
  );
  task.prUrl = committed.prUrl || task.prUrl;
  task.checksPassed = true;
  task.exceptionNote = gates.notes.length && !validation.passed ? gates.notes.join("; ") : task.exceptionNote;
  const review = transitionTask(task, "review", {
    now: deps.now.toISOString(),
    checksPassed: true,
    exceptionNote: task.exceptionNote,
  });
  await deps.saveTask(review);
  await push(deps, review, "review");
  run.status = "succeeded";
  await deps.updateRun(run);
  deps.scheduler.activeRunId = null;
  deps.scheduler.consecutiveFailures = 0;
  deps.scheduler.retryAt = null;
  deps.scheduler.lastTickAt = deps.now.toISOString();
  await deps.saveScheduler(deps.scheduler);
  const ready = draft(
    deps,
    review,
    "warning",
    `${review.title} is ready for review`,
    [
      `${review.title} is ready for review.`,
      review.branchName ? `Branch: ${review.branchName}` : "",
      review.prUrl ? `Pull request: ${review.prUrl}` : "",
      result.summary,
      gates.notes.join("\n"),
    ].filter(Boolean).join("\n"),
    "Approve it to merge, or reject it to send the ticket back to Doing.",
  );
  if (review.prUrl) ready.links = [...(ready.links ?? []), { label: "Pull request", url: review.prUrl }];
  await deps.notify(ready);
  await rememberBuild(deps, review, "review", result.summary);
  return { action: "review", taskId: review.id, detail: result.summary };
}

async function rememberBuild(deps: TickDeps, task: Task, phase: "start" | "review" | "failed", note: string): Promise<Memory | null> {
  if (!deps.remember) return null;
  try {
    return await deps.remember({ task, phase, note });
  } catch {
    return null;
  }
}

async function push(deps: TickDeps, task: Task, stage: Stage): Promise<void> {
  if (!deps.board) return;
  if (stage === "done") assertCanPushDone(false);
  const column = columnForStage(deps.workflow.columns, stage);
  if (!column) return;
  await deps.board.moveCard(task.externalId, column);
}

function replaceTask(tasks: Task[], task: Task): void {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = task;
}

function draft(deps: TickDeps, task: Task, severity: NotificationDraft["severity"], title: string, body: string, action?: string): NotificationDraft {
  return {
    agentName: deps.agent.name,
    repository: deps.agent.repositoryName,
    taskTitle: task.title,
    status: task.stage,
    severity,
    title,
    body,
    action,
    links: task.url ? [{ label: "Ticket", url: task.url }] : [],
  };
}

export { approveTask };
