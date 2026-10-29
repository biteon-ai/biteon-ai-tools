CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('created', 'running', 'paused', 'stopped', 'error')),
  repository_url text NOT NULL DEFAULT '',
  repository_name text NOT NULL DEFAULT '',
  default_branch text NOT NULL DEFAULT 'main',
  provider text NOT NULL CHECK (provider IN ('none', 'trello', 'github_projects')),
  board_id text NOT NULL DEFAULT '',
  board_name text NOT NULL DEFAULT '',
  workspace_path text NOT NULL,
  executor_kind text NOT NULL CHECK (executor_kind IN ('fake', 'llm', 'cursor', 'codex')),
  daily_capacity_hours double precision NOT NULL DEFAULT 8,
  allow_over_capacity boolean NOT NULL DEFAULT false,
  credential_secret_id uuid,
  telegram_chat_id text NOT NULL DEFAULT '',
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  columns jsonb NOT NULL,
  selection jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  acceptance_criteria text NOT NULL DEFAULT '',
  comments jsonb NOT NULL DEFAULT '[]',
  url text NOT NULL DEFAULT '',
  stage text NOT NULL CHECK (stage IN ('backlog', 'planning', 'todo', 'doing', 'review', 'done', 'blocked', 'failed')),
  priority integer NOT NULL DEFAULT 3,
  estimate_hours double precision,
  depends_on jsonb NOT NULL DEFAULT '[]',
  due_at timestamptz,
  plan text NOT NULL DEFAULT '',
  branch_name text NOT NULL DEFAULT '',
  pr_url text NOT NULL DEFAULT '',
  blocked_reason text NOT NULL DEFAULT '',
  exception_note text NOT NULL DEFAULT '',
  checks_passed boolean NOT NULL DEFAULT false,
  labels jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (agent_id, external_id)
);

CREATE TABLE task_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  executor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  activity text NOT NULL,
  model_id text NOT NULL DEFAULT '',
  cost_class text NOT NULL,
  summary text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE TABLE task_events (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE INDEX task_events_agent_created_idx ON task_events (agent_id, created_at DESC);

CREATE TABLE checkpoints (
  id uuid PRIMARY KEY,
  task_run_id uuid NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  step integer NOT NULL,
  note text NOT NULL DEFAULT '',
  owned_files jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ui', 'telegram', 'board', 'import')),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor text NOT NULL,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE TABLE memories (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE memory_revisions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE secrets (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  hint text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE providers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  cost_class text NOT NULL CHECK (cost_class IN ('local', 'hosted_free', 'paid')),
  enabled boolean NOT NULL DEFAULT true,
  secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE models (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  display_name text NOT NULL,
  cost_class text NOT NULL CHECK (cost_class IN ('local', 'hosted_free', 'paid')),
  enabled boolean NOT NULL DEFAULT true,
  parameters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE TABLE model_assignments (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  activity text NOT NULL,
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  fallback_model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  max_tokens integer NOT NULL DEFAULT 4000,
  daily_token_budget integer,
  allow_local_only boolean NOT NULL DEFAULT false,
  require_paid boolean NOT NULL DEFAULT false
);

CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  model_id text NOT NULL,
  activity text NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  cost_class text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE telegram_config (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  bot_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  chat_id text NOT NULL DEFAULT '',
  min_severity text NOT NULL DEFAULT 'warning',
  digest_minutes integer NOT NULL DEFAULT 60,
  last_digest_at timestamptz
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  task_id uuid,
  severity text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  links jsonb NOT NULL DEFAULT '[]',
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE INDEX notifications_created_idx ON notifications (created_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE TABLE scheduler_state (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_plan_at timestamptz,
  last_tick_at timestamptz,
  active_run_id uuid,
  retry_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE TABLE heartbeats (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
