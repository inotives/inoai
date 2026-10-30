---
status: accepted
---

# The UI writes Tasks directly through short-lived SQLite connections

The local UI server may create, edit, and control Tasks. It does this through a short-lived SQLite write connection per request, with the 5-second busy timeout from ADR 0025. Task writes are the only UI writes; all other UI data stays read-only. The UI never reads `.env`. The running agent picks up each change from SQLite on its next scheduler check.

This was chosen over three alternatives:

- **A request queue** that the agent drains. It adds a table, a polling loop, and a second state for every action, and the UI cannot report the outcome directly.
- **IPC** between the UI server and the agent. It adds a channel, a protocol, and an authentication boundary, and it fails when the agent is stopped.
- **Embedding the UI in the agent process.** It breaks the rule that the core and the UI are separate applications, and the UI would stop when the agent stops.

SQLite already serializes writers, and ADR 0025 already allows short-lived maintenance writes while the agent holds the Runtime Home Lock.

## Routes

| Route | Action | Success |
| --- | --- | --- |
| `POST /api/tasks` | Create a Task. | 201 `{ task }` |
| `PATCH /api/tasks/:id` | Replace the title, instruction, expected output, and schedule. | 200 `{ task }` |
| `POST /api/tasks/:id/run` | Run now. | 200 `{ task }` |
| `POST /api/tasks/:id/pause` | Pause. | 200 `{ task }` |
| `POST /api/tasks/:id/resume` | Resume. | 200 `{ task }` |
| `POST /api/tasks/:id/cancel` | Cancel. | 200 `{ task }` |

A wrong method returns 405. An unknown `/api/tasks/...` path returns 404. `{ task }` has the same shape as a `tasks` item in `/api/ui-data`.

## Security checks

The UI server listens on `127.0.0.1` by default. An explicit `--host` may bind it to one private LAN IPv4 address. Every write request passes these checks in this order:

1. `Host` is `127.0.0.1:<port>` or `localhost:<port>` by default. With a LAN bind, only `<selected-address>:<port>` is accepted.
2. `Origin` is `http://` followed by an accepted Host.
3. `Content-Type` is `application/json`. Parameters such as `charset` are ignored.
4. The `x-inoai-token` header matches the per-launch token. The server creates the token from 32 random bytes at launch and embeds it in the served page as `<meta name="inoai-ui-token">`. It compares SHA-256 digests with a constant-time comparison.
5. The body is at most 32 KB. The server checks `Content-Length` and counts bytes while it reads.

There is no login. The token proves that the request comes from the page that this UI launch served. Any device on the selected LAN can get that page, read UI data, and use its token to change Tasks. The token and Origin checks do not authenticate LAN users. LAN traffic uses plain HTTP; use this mode only on a trusted LAN.

Response codes:

- **403** `{"error":"Forbidden."}`: a security check failed. The server closes the connection.
- **400**: the body is not valid JSON, or the Task fails validation. Validation errors include `fields`, keyed by field name.
- **404**: the Task does not exist.
- **409**: the action does not fit the current state. Examples: the Task is not active or paused; a run is in progress; the database file is missing; the database does not have the Task schedule columns yet; the runtime home has no owner session.
- **503** `{"error":"The database is busy. Try again.","retryable":true}`: SQLite stayed busy for the full 5-second timeout. Nothing was written. Retry the action.
- **500**: the database file is unsafe, for example a symlink, or the write failed for another reason.

Logging rule: a request that fails a security, JSON, method, or route check, and a write that returns 500 or 503, logs one line: `ui task write rejected: <method> <path> <reason>`. The server never logs the token, headers, or body.

## Writes

Each write uses actor `ui:owner` in `created_by` and `updated_by`. Each action runs in one `BEGIN IMMEDIATE` transaction, so it is serialized with the agent's run claims.

- **Create.** The server finds the most recent non-deleted session whose User has role `owner`. It copies `user_id`, `transport`, `workspace_id`, `agent_provider`, and `project_path` into a new placeholder session:
  - `conversation_id` and `initiating_external_message_id`: `pending:ui:<uuid>`;
  - `parent_conversation_id`: `pending:ui`;
  - `agent_session_id`: `pending:task:<uuid>`.

  It then inserts the Task. If no owner session exists, it returns 409 "Talk to the agent in Discord once before creating tasks from the UI."
- **Edit.** Only an active or paused Task with no run in progress. The new spec replaces the old one. The next run is recalculated from now; completed and failed runs count toward the run limit. If the new schedule has no run left, the server returns 400.
- **Run now.** Only an active Task with no run in progress. The server sets the next run to now. The scheduler starts it on its next check, about once per minute.
- **Pause and resume.** Pause stops new runs; a run in progress finishes. Resume recalculates the next run from now. A legacy Task keeps its existing due time on resume.
- **Cancel.** The server sets the Task to `cancelled`. A run in progress finishes and is recorded normally; no later run starts. The Discord `/inoai task cancel` command keeps its existing behaviour and also cancels the run in progress.

Cancelled and completed Tasks are read-only. Nothing is deleted.

The UI never creates or migrates the database. A missing `inoai.sqlite` or a database without the Task schedule columns returns 409 and asks the owner to start the agent once.

UI writes do not require the agent to run. Edits made while the agent is stopped are picked up on its next start. The page shows when the agent is stopped.

## Result file and task channel

The agent writes `results/<task-id>/<run-id>/result.md` for every completed and failed run whose run folder was created. A run that fails before its folder exists, a run failed by startup recovery, and a cancelled run get no `result.md`. Superseded by IP-0005: a cancelled run now gets `State: cancelled`, and a run failed by startup recovery gets `State: failed` with "Interrupted by restart"; see `docs/sqlite-schema.md`. The file holds the run metadata, the instruction, the expected output, and the full answer or a safe failure reason, followed by the list of other files in the run folder. The UI reads it only when every folder on the path is a real directory inside `results/`, the file is a regular file with one link, it is at most 64 KB, and it contains no NUL bytes. The UI never writes it.

`DISCORD_TASK_CHANNEL_ID` is optional and is read only by the agent. When it is set, the agent creates a thread for a UI-created Task on its first run and posts run reports there. When it is unset, UI-created Tasks run without a Discord thread. The value must be digits only. It must not equal `DISCORD_STATUS_CHANNEL_ID`, because inoai ignores messages in threads of the status channel; Task thread guidance would be dropped. Configuration does not check this.

## Redaction

The UI redacts credential-shaped text in Task titles, instructions, expected output, schedule labels, failure details, and `result.md` before it sends them to the page. Raw text never reaches the page. Each Task lists its redacted fields in `redactedFields`. The edit form marks those fields and refuses to save while a marked field still equals its redacted prefill. The owner must re-enter the text first. A field that still contains a `[redacted]` placeholder after a partial edit is saved as typed.

## Consequences

- SQLite stays the source of truth. No request queue, IPC channel, or new table is needed.
- A busy write can block the UI server for up to 5 seconds. This is acceptable for a local single-owner UI.
- A UI-created Task keeps the agent provider that it copied from the latest owner session at creation. After any `AGENT_PROVIDER` change, its runs fail with "Task Agent Session unavailable"; talking to the agent does not fix that Task. A Task created after the change but before a new owner session exists also copies the old provider. The owner talks to the agent under the new provider, then creates the Task again. Superseded by ADR 0028: Task runs now follow the active provider, so such a Task heals on its first run.
- Read requests keep their existing behaviour. The page and `/api/ui-data` do not check `Host`; only writes do. Superseded by IP-0004: every request now needs an accepted `Host`, and any other Host gets 403 on every path. The default accepted hosts are `127.0.0.1:<port>` and `localhost:<port>`; a LAN bind accepts only its selected address and port. `/` accepts GET and HEAD, `/api/ui-data` accepts GET, other methods get 405, and unknown paths get 404.
- All other UI data, including Memory, the allowlist, and sessions, stays read-only. Any further UI write needs a new decision.
