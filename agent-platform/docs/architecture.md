# Architecture

The web app is the only browser origin. Next.js rewrites `/api` to the Fastify service, so provider credentials never reach client-side code. Fastify owns configuration, sessions, and board lookups. The worker owns scheduling, execution, and Telegram delivery.

```text
browser -> web -> api -> postgres
                    \-> redis -> worker -> workspace
```

Each agent row points at one repository, one board, one workspace directory, and one rules document. Project memory is stored in Postgres and versioned in `memory_revisions`. A git checkout is a cache. The repository, its history, and its tests outrank memory.

Executors implement `run` and `cancel`:

- `fake` records a marker file and does not call a model.
- `llm` calls an OpenAI-compatible `/chat/completions` endpoint and can read, search, write, and run allowlisted commands inside the workspace.
- `cursor` uses `@cursor/sdk` with `local.cwd` set to the workspace and `settingSources: []`. Cloud agents are not used.
- `codex` runs `codex exec --sandbox workspace-write` when the CLI and API key exist.

The worker selects the executor from the coding model assignment unless the agent is pinned to the fake executor. Startup failures from the Cursor SDK stay distinct from runs that start and return `status: "error"`.

With `DOCKER_RUNTIME=false`, commands run in the worker process with a replaced environment and an allowlist. With `DOCKER_RUNTIME=true`, the worker starts one container per running agent on the `agent-platform-agents` network, mounts only that workspace, and does not mount the Docker socket into the agent container. The worker itself must hold the socket to start those containers. That is a privileged control-plane capability and is documented as such.
