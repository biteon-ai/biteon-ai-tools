# Security

Sessions are HttpOnly cookies signed with `SESSION_SECRET`. The first admin user is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` when the user table is empty. This v1 build is single-admin.

Secrets are encrypted with AES-256-GCM. The key is `APP_MASTER_KEY` and must be at least 32 characters. API responses return a configured flag and a short hint. Logs pass through a redactor for common token shapes. Child processes started for validation do not inherit the worker environment.

Ticket text, comments, and repository files are wrapped as untrusted data. Tool calls still pass through the policy gate:

- Paths must stay inside the agent workspace, including symlink targets.
- `.git` is not writable through the file tool.
- Git may inspect, branch, add, commit, fetch, and push. Force push, hard reset, amend, rebase, hook skipping, and branch deletion are rejected.
- Shell composition is rejected because commands are spawned as argv, not through a shell.
- The agent cannot transition a task to Done. The API and Telegram commands can, and only from Review.

Validation commands are required before Review unless `allowEmptyChecks` is explicitly enabled. The secrets-scan skill blocks Review when a diff contains credential material. Other skills add review notes for risky patterns, dependency changes, migrations, and CI files.

Known limitations:

- The agent runtime image runs as root. It drops no Linux capabilities beyond `no-new-privileges` and a pid limit.
- Enabling `DOCKER_RUNTIME` gives the worker access to the host Docker socket.
- Codex and git credentials for push are process environment variables for that command only. They are not written to the repository.
- Attachment bytes on Trello cards are not downloaded. The card URL is kept.
