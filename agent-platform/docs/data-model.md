# Data model

Migrations live in `packages/db/migrations` and are applied by the API on startup. `schema_migrations` records the filename. Drizzle models in `packages/db/src/schema.ts` match the SQL.

Main tables:

- `users`, `agents`, `workflows`, `tasks`, `task_runs`, `task_events`, `checkpoints`, `approvals`
- `memories`, `memory_revisions`
- `secrets`, `providers`, `models`, `model_assignments`, `usage_ledger`
- `telegram_config`, `notifications`, `audit_logs`, `scheduler_state`, `heartbeats`

Deleting an agent cascades its tasks, runs, memory, and scheduler state. Secret rows are kept so a shared provider credential is not destroyed with one agent. Workspace directories are retained and marked with a `REMOVED` file.

Each agent stores an optional board credential (`credential_secret_id`) and a required GitHub repository credential (`repository_secret_id`) used to authenticate clone, push, pull requests, and linked repositories.

Task stage values are constrained by the database and again by `assertTransition`. `done` is not a normal edge in the transition map; the function allows it only from `review` when `approval` is true.
