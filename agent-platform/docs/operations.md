# Operations

## Timezone

Containers and day budgets use `Europe/Amsterdam` (`TZ`). Timestamps stay stored in UTC; the UI and capacity windows convert to Amsterdam wall time.

## Health

- API: `GET /health` and `GET /ready` (ready requires Postgres)
- Worker: port 4001, same paths
- Web: `GET /login`
- Compose restarts services unless they are stopped. Memory and CPU limits are set on each service.

The worker writes a heartbeat row every scheduler interval. The dashboard shows that payload and when it was last updated.

## Backups

From a host that can reach Postgres:

```sh
DATABASE_URL=postgres://agent:change-me-now@127.0.0.1:5432/agent_platform \
  WORKSPACES_DIR=/var/lib/agent-platform/workspaces \
  ./scripts/backup.sh
```

Inside Compose, run `pg_dump` from a one-off container attached to the Compose network if the host does not have the client. The script writes a custom-format dump and, when the workspace directory exists, a tarball.

Restore is destructive. It requires `CONFIRM=restore`:

```sh
CONFIRM=restore DATABASE_URL=postgres://... ./scripts/restore.sh backups/<stamp>
```

## Recovery drill

`scripts/recovery-drill.sh` dumps the local database, restores it into `agent_platform_drill`, checks `schema_migrations`, and drops the drill database. It exits if `DATABASE_URL` does not point at localhost.

## Upgrades

1. Back up the database and workspaces.
2. Pull the new revision.
3. `docker compose up -d --build`.
4. Confirm `/ready` and a worker heartbeat.
5. If a migration fails, stop the API and restore the dump. Do not delete the `postgres-data` volume.

## Container runtime

Build the runtime image, mount the Docker socket on the worker, and set `DOCKER_RUNTIME=true`:

```sh
docker compose --profile runtime build agent-runtime
```

Add `/var/run/docker.sock:/var/run/docker.sock` to the worker service before starting it with that flag. Agent containers join `agent-platform-agents` and do not receive the socket. Postgres stays on the control network.

## Failure behavior

Provider errors, invalid model output, failed checks, and foreign dirty files keep the task out of Review. Retries use exponential backoff capped at 60 minutes and stop after `maxRetries`. A stalled run with no checkpoint progress is blocked and a notification is recorded. The worker does not force a task through by rewriting history.
