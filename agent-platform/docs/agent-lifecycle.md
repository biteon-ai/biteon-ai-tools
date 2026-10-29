# Agent lifecycle

Create an agent from the UI or `POST /api/agents`. The default name is `{board or repository} Agent`. The row starts in `created`. Start, pause, resume, restart, and stop change that status. Start, resume, and restart enqueue a tick. Remove deletes the database rows and leaves the workspace in place.

On each tick the worker:

1. Syncs the board when credentials exist.
2. Continues a Doing task from its checkpoint, or blocks it when the stall window passes or retries are exhausted.
3. Otherwise selects Backlog and Planning tasks that fit the remaining daily hours, dependencies, and blocked labels.
4. Moves the next task to Doing, prepares a branch, and calls the executor.
5. Runs validation commands and quality gates.
6. Commits owned files and pushes only when a remote and token exist.
7. Moves the task to Review and writes a memory entry.

A pushed commit is not completion. Review requires the gates to pass, or `allowEmptyChecks` when no commands are configured. Done happens only through approval.

Telegram commands, accepted only from the configured chat id:

- `/status`
- `/pause <agent id or name>`
- `/resume <agent id or name>`
- `/approve <task id or external id>`
- `/reject <task id or external id>`

Info notifications are held for the digest interval. Warning and urgent notifications send immediately when they meet the configured minimum severity.
