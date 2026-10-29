# Agent Platform

Self-hosted control plane for one development agent per repository. Agents share the API, worker, Postgres, and Redis services, and each agent is limited to its own workspace. The worker plans from a Trello board or GitHub Project, implements through a pluggable executor, and stops in Review. A person approves work before it can reach Done.

## Stack

- Next.js web UI
- Fastify API
- BullMQ worker
- Postgres and Drizzle
- Redis
- Executors: constrained OpenAI-compatible tool loop (Ollama or hosted APIs), Cursor SDK local runtime, and Codex CLI

## Setup

1. Install Docker, Docker Compose, and Node.js 22 if you want to run tests outside containers.
2. Copy the environment file and replace every placeholder:

```sh
cp .env.example .env
```

3. Start the stack:

```sh
docker compose up -d --build
```

4. Open `http://localhost:3000`, sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, and create an agent.

The API applies database migrations and creates the first admin user on startup. Postgres is published only on `127.0.0.1:5432`.

## Agent workflow

The fixed stages are Backlog, Planning, To Do, Doing, Review, and Done, plus Blocked and Failed. Column names are configurable. The agent may select work that fits the remaining daily capacity, implement it on an `agent/{task}-{slug}` branch, and move it to Review after validation. Done is rejected unless an approval record exists. Approvals come from the agent page, Telegram (`/approve`), or a human moving a Review card to Done on the board.

Set the executor to **Fake** to exercise the lifecycle without a model. Set it to **Model router** and assign planning, coding, testing, and review models before expecting code generation. Ollama providers must use the `local` cost class. OpenAI, Anthropic, Cursor, and Codex providers must use `paid`.

## Commands

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm migrate
```

`pnpm test:integration` applies the store contract to Postgres. It refuses non-local database URLs.

## Operations

Backup and recovery commands live in `scripts/` and are described in [docs/operations.md](docs/operations.md). Container-per-agent isolation is off by default (`DOCKER_RUNTIME=false`). The process runtime still jails paths and git commands. See [docs/security.md](docs/security.md) before enabling the Docker runtime.

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Data model](docs/data-model.md)
- [Operations](docs/operations.md)
- [Agent lifecycle](docs/agent-lifecycle.md)
- [API](docs/api.md)
- [Testing](docs/testing.md)
- [Changelog](docs/changelog.md)
