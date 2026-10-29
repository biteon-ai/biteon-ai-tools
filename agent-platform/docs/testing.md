# Testing

`pnpm test` runs unit tests for the workflow gate, path and git policy, encryption, redaction, capacity planning, model cost labels, the tool-loop rejection of `git push --force`, Cursor startup versus run failure, the Codex sandbox arguments, the HTTP API, and an end-to-end tick against a temporary git repository.

`pnpm test:integration` repeats the store round trip against `DATABASE_URL` when that URL points at localhost or the Compose postgres host.

GitHub Actions runs lint, typecheck, unit tests, migrations, and the integration test against a Postgres service. The web build is covered by `docker compose build`.

The end-to-end tick uses the fake executor so it does not call a hosted model. It still initializes a repository, commits the owned file, and stops in Review. A second case runs `node -e process.exit(1)` and asserts the task stays in Doing.
