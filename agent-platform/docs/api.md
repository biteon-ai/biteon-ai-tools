# API

All routes except `GET /health`, `GET /ready`, and `POST /api/auth/login` require the session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | Set the session cookie |
| POST | `/api/auth/logout` | Clear the cookie |
| GET | `/api/dashboard` | Counts, usage, alerts, heartbeat |
| GET/POST | `/api/agents` | List or create agents. `linkedRepositories` holds secondary `owner/name` repositories |
| GET/PATCH/DELETE | `/api/agents/:id` | Read, edit, or remove one agent |
| POST | `/api/agents/:id/{start,stop,pause,resume,restart,tick,sync}` | Lifecycle, queue a tick, or sync the board |
| GET/POST | `/api/agents/:id/tasks` | List or create a local task |
| GET/POST | `/api/agents/:id/memories` | Read or append project memory |
| PUT | `/api/agents/:id/workflow` | Column names and selection limits |
| GET | `/api/agents/:id/board-columns` | Column names from the connected board |
| PUT | `/api/agents/:id/rules` | Standards, commands, and skills |
| POST | `/api/agents/:id/skills` | Add a custom skill for one agent |
| POST | `/api/agents/:id/chat` | Status, ticket list, or shift the active ticket |
| POST | `/api/tasks/:id/approve` | Approve a Review task |
| POST | `/api/tasks/:id/reject` | Return a Review task to Doing |
| GET/POST/PATCH/DELETE | `/api/providers` | Model providers. POST updates an existing provider when the name already exists, or when another Ollama provider exists. Multiple Cursor, OpenAI, Anthropic, and Codex accounts are allowed under distinct names. Responses contain credential hints only |
| POST | `/api/providers/:id/probe` | Check that a provider is reachable |
| GET/POST/PATCH | `/api/models` | Models under a provider |
| PUT | `/api/assignments` | Activity routing, fallback, and budget |
| GET/PUT | `/api/telegram` | Bot token, chat, and severity |
| POST | `/api/telegram/pair` | Start a Telegram deep-link pairing session |
| GET | `/api/telegram/pair/:token` | Poll a pairing session |
| POST | `/api/telegram/test` | Send a test alert to the paired chat |
| POST | `/api/integrations/trello/boards` | List boards for a key and token |
| POST | `/api/integrations/github/account` | Verify a GitHub personal access token and list repositories the account can access |
| POST | `/api/integrations/github/projects` | List Projects v2 for a repository |

Creating or updating an agent requires a primary repository (`repositoryName` or `repositoryUrl`) and a GitHub account token (`repositoryToken`) used for clone, push, pull requests, and linked repositories. Leave `repositoryToken` blank on update to keep the saved credential.

Trello credentials are stored as JSON `{"key","token"}`. GitHub credentials are stored as `{"token"}` or a raw token. The browser sends them once over the same origin; the API encrypts them before insert.
