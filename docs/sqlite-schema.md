# inoai SQLite schema

This is the SQLite schema for the chat-to-agent bridge. Times are Unix seconds. External platform identifiers are `TEXT` to avoid JavaScript integer precision loss. Runtime startup applies new tables and indexes with idempotent `CREATE ... IF NOT EXISTS` statements, so existing runtime homes keep their rows while gaining the Task schema. Startup then adds any missing Task schedule columns with `ALTER TABLE tasks ADD COLUMN` in one immediate transaction. Fresh and existing homes get these columns the same way. The UI server never creates or migrates the database (ADR 0026).

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'family' CHECK (role IN ('owner', 'family')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)),
  UNIQUE (transport, workspace_id, external_user_id)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiating_external_message_id TEXT NOT NULL,
  agent_provider TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'ended', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  ended_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

-- Reset may end a session and create another in the same external conversation.
CREATE UNIQUE INDEX one_active_session_per_conversation
  ON sessions(transport, workspace_id, conversation_id)
  WHERE state = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX unique_initiating_message
  ON sessions(transport, workspace_id, initiating_external_message_id);
CREATE UNIQUE INDEX unique_agent_session
  ON sessions(agent_provider, agent_session_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_message_id TEXT,
  external_author_id TEXT,
  user_id INTEGER REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('user', 'agent')),
  body TEXT NOT NULL,
  reply_to_external_message_id TEXT,
  in_reply_to_message_id INTEGER REFERENCES messages(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  failure_detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  started_at INTEGER,
  runtime_started_at INTEGER,
  completed_at INTEGER,
  provisional_id TEXT UNIQUE,
  delivery_state TEXT CHECK (delivery_state IN ('pending', 'uncertain', 'confirmed', 'failed')),
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK (direction != 'user' OR external_message_id IS NOT NULL),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE UNIQUE INDEX unique_external_message
  ON messages(transport, workspace_id, external_message_id);

-- The global worker claims the oldest pending user message.
CREATE INDEX pending_user_messages
  ON messages(direction, state, id);
CREATE INDEX messages_by_session
  ON messages(session_id, id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  message_id INTEGER REFERENCES messages(id),
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX events_by_session
  ON events(session_id, id);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  runtime_approval_id TEXT NOT NULL UNIQUE,
  request_message_id INTEGER REFERENCES messages(id),
  resolution_message_id INTEGER REFERENCES messages(id),
  summary TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX pending_approvals_by_session
  ON approvals(session_id, id)
  WHERE state = 'pending' AND deleted_at IS NULL;

CREATE TABLE memory_reviews (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  from_message_id INTEGER NOT NULL REFERENCES messages(id),
  through_message_id INTEGER NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  recap TEXT,
  failure_detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  started_at INTEGER,
  completed_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX due_memory_reviews
  ON memory_reviews(state, next_attempt_at, id);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  source_message_id INTEGER REFERENCES messages(id),
  created_by_user_id INTEGER REFERENCES users(id),
  review_id INTEGER REFERENCES memory_reviews(id),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'review')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX active_memories
  ON memories(state, id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
  task_type TEXT NOT NULL CHECK (task_type IN ('one_time', 'recurring')),
  interval_seconds INTEGER,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'paused', 'completed', 'cancelled')),
  conversation_id TEXT NOT NULL,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  next_due_at INTEGER,
  message_cursor INTEGER NOT NULL DEFAULT 0 CHECK (message_cursor >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((task_type = 'one_time' AND interval_seconds IS NULL) OR
    (task_type = 'recurring' AND interval_seconds > 0 AND interval_seconds % 3600 = 0)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX due_tasks
  ON tasks(state, next_due_at, id)
  WHERE deleted_at IS NULL;

-- Task schedule columns. Startup adds each missing column. All are nullable and have no CHECK.
ALTER TABLE tasks ADD COLUMN title TEXT;          -- at most 100 characters; names the Task thread
ALTER TABLE tasks ADD COLUMN output_spec TEXT;    -- expected output, at most 2,000 characters
ALTER TABLE tasks ADD COLUMN timezone TEXT;       -- canonical IANA name, for example 'Asia/Singapore'
ALTER TABLE tasks ADD COLUMN schedule_kind TEXT;  -- 'once', 'interval', 'daily', 'days', 'weekly', or NULL (legacy)
ALTER TABLE tasks ADD COLUMN schedule_time TEXT;  -- 'HH:MM' local time for daily, days, and weekly
ALTER TABLE tasks ADD COLUMN schedule_days TEXT;  -- comma list such as 'mon,tue,wed' for days; one day for weekly
ALTER TABLE tasks ADD COLUMN ends_at INTEGER;     -- optional stop date
ALTER TABLE tasks ADD COLUMN max_runs INTEGER;    -- optional run limit

CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_detail TEXT CHECK (failure_detail IS NULL OR length(failure_detail) <= 500),
  artifact_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_paths_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((state = 'processing' AND completed_at IS NULL) OR
    (state != 'processing' AND completed_at IS NOT NULL)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE UNIQUE INDEX one_active_task_run
  ON task_runs(state)
  WHERE state = 'processing' AND deleted_at IS NULL;
CREATE INDEX task_runs_by_task
  ON task_runs(task_id, id)
  WHERE deleted_at IS NULL;
```

## Audit fields

Every persisted table has `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`, and `deleted_by`. Actor fields are normalized text such as `system`, `user:42`, `transport:discord`, or `agent:codex`; this supports automated and human actions without a second actor table. `deleted_at` and `deleted_by` form a soft-delete pair: records are not physically removed in V1, and ordinary queries exclude soft-deleted rows. Soft-deleted records are hidden with no restore action in V1.

## How the tables work

- A transport-specific start action creates one `sessions` row and one initial `messages` row. `agent_provider` and `agent_session_id` identify the selected CLI runtime session; `conversation_id` is the transport conversation boundary (a Discord thread in v1).
- `agent_session_id` starts as a `pending:<external message id>` placeholder until the runtime creates its session. Codex and Claude return their final ID at creation. OpenCode only assigns its `ses_…` ID after the first Turn starts, so its adapter binds an `inoai-new:<uuid>` placeholder and the first streamed event with a session ID triggers a conditional update to the real ID (only while the row is active, not soft-deleted, and still holds that placeholder; audited as `runtime:opencode`). An `inoai-new:` placeholder that survives a restart means no OpenCode session was ever observed; the next Turn fails closed with the `/inoai reset` notice.
- `users` is the transport-scoped allowlist. Startup upserts the configured owner as its first active `owner` record; V1 creates no other active User records.
- Every eligible conversation message is inserted into `messages` before it is processed and references its User. The worker claims the oldest `user`/`pending` row. Agent responses are stored as `agent` rows, one per transport message chunk, linked by `in_reply_to_message_id`.
- Phase 5 persists each agent response chunk before Discord delivery. An unsent chunk has a local `provisional_id` and a null `external_message_id`; the latter is filled only after Discord confirms delivery. `delivery_state` moves from `pending` to `uncertain` before send, then to `confirmed` or known `failed` when the outcome is known. A chunk left `uncertain` after restart is never resent automatically; the archived body remains available locally. Legacy agent Messages with an already-known external ID migrate as `confirmed`.
- `events` stores health checks, connection changes, session lifecycle events, and errors. Its `session_id` is nullable so `inoai is online` can be recorded without a conversation.
- A `memory_reviews` row is a timestamped recap entry. It records the source range since that Agent Session's last completed recap, its concise recap text, and any Memory actions. Only normal chat work runs ahead of it.
- Daily scheduling uses Events rather than new tables: one `memory_review_cycle` Event per local date, `memory_review_deferred` when chat preempts a review (five per review per day at most), and `memory_review_skipped` for a runtime without review support. Reviews may update or delete only `origin = review` Memory; dropped actions are recorded as non-secret `ignored` outcomes.
- `memories` contains durable Manual Memory Entries and reviewed entries in one agent-wide shared namespace. A Manual Memory Entry identifies its owner User when available; a reviewed entry identifies its source Message and Recap. `origin` is provenance for retrieval: all active Memory is retrieved the same way, but Memory Reviews may change only `origin = review` entries. Soft-delete changes state without removing history.
- `tasks` binds one bounded goal to its Conversation and Agent Session. `goal` holds the instruction. A legacy Task (`schedule_kind` NULL, created by `/inoai task create`) keeps its earlier behaviour: a one-time Task has no interval or automatic due time, and a recurring interval uses whole hours stored as seconds, with the first due time one interval after creation. A scheduled Task (`schedule_kind` set) follows the rules in [Task schedules](#task-schedules). The cursor is the newest archived message consumed by the Task.
- `task_runs` records one Agent Runtime iteration and output paths relative to the runtime home, under `results/<task-id>/<run-id>/`. The files remain outside SQLite but inside the runtime home. A completed run's `artifact_paths_json` includes `result.md`. The partial unique index permits only one active run in an Agent Instance database. Failure details are capped at 500 characters and credential-shaped values are redacted. Startup marks interrupted runs failed without retrying them. It sets a legacy recurring Task's next due time one interval after recovery, and a scheduled Task's next run from the schedule.
- `approvals` remains in the schema for compatibility, but V1 creates no new pending approvals or Discord approval controls (ADR 0003). Codex approval requests are declined immediately; only a non-secret outcome Event is stored. On restart, any pending row left by an earlier local build becomes `failed`; legacy summaries and linked agent-authored request bodies are redacted, without changing user-authored Messages. Its saved data is never authority to answer or replay a lost runtime request (ADR 0001).

## Task schedules

The shared module `src/inoai/tasks/schedule.ts` validates Task schedules and computes the next run. The agent and the UI server both use it. Every scheduled Task stores `timezone`, and all clock times use that time zone.

| Schedule | `task_type` | `interval_seconds` | Other columns | First run |
| --- | --- | --- | --- | --- |
| `once`, now | `one_time` | NULL | none | creation time |
| `once`, at a time | `one_time` | NULL | none | that time |
| `interval`, every N hours | `recurring` | N × 3600 (N ≥ 1, whole) | none | one interval after creation |
| `daily` | `recurring` | 86400 | `schedule_time` | next `HH:MM` |
| `days` | `recurring` | 86400 | `schedule_time`, `schedule_days` (comma list, `mon`…`sun` order) | next `HH:MM` on a listed day |
| `weekly` | `recurring` | 86400 | `schedule_time`, `schedule_days` (one day) | next `HH:MM` on that day |

- Clock kinds (`daily`, `days`, `weekly`) are stored as recurring Tasks with 86400 seconds, so the existing CHECK holds. Next-run computation uses `schedule_time`, `schedule_days`, and `timezone`, not the interval.
- A scheduled one-time Task stores its run time in `next_due_at`. A legacy one-time Task still cannot have a `next_due_at`.
- `ends_at` and `max_runs` apply only to repeating kinds. `once` rejects them.

Next-run rules for a scheduled Task:

- The scheduler starts any active Task whose `next_due_at` is at or before now, one run at a time, at startup and about once per minute.
- When a run ends, the next run is computed from the end time and the number of `completed` and `failed` runs so far. This applies to completed, failed, and restart-interrupted runs. A Task paused during its run stays paused.
- A clock kind runs at the first local `schedule_time` strictly after that time, on an allowed day. After downtime, an overdue Task runs once; missed slots are not replayed.
- An `interval` Task runs N elapsed hours after the run ends.
- Daylight saving time: a skipped local time runs at the first valid instant after the gap. For example, 02:30 on New York's spring-forward day runs at 03:00 EDT. A repeated local time runs once, at its earlier instant.
- Stop conditions: when the run count reaches `max_runs`, or the next run would be after `ends_at`, the Task becomes `completed` and `next_due_at` becomes NULL. A run exactly at `ends_at` is allowed. A `once` Task completes after its run.
- Failed and interrupted runs count toward `max_runs`, and the Task moves to its next slot. A scheduled one-time Task whose only run fails ends `completed`.
- Run now sets `next_due_at` to now, and the run counts toward `max_runs`. For a clock kind it is an extra run: the next clock slot still runs, even a few minutes later. For `interval`, the next run is N hours after the Run now run ends. For `once` at a time, Run now replaces the stored run time: that run is the Task's one run, and the Task then completes.
- Resume recalculates the next run from now. It completes the Task when a stop condition is already reached.
- A UI edit replaces the spec and recalculates the next run from now with the runs so far. Editing a legacy Task from the UI writes its schedule columns, so it becomes a scheduled Task.
- A row with invalid schedule columns completes after its next run, recovery, or resume.

Legacy rows (`schedule_kind` NULL) keep the earlier rules: a one-time Task waits for `/inoai task run`, and a recurring Task is next due one interval after a run ends.

### UI-created Tasks

The UI server creates a placeholder `sessions` row and the Task in one immediate transaction, with actor `ui:owner` (ADR 0026). It copies `user_id`, `transport`, `workspace_id`, `agent_provider`, and `project_path` from the most recent session of an owner User. The placeholder values satisfy the unique session indexes:

- `conversation_id` and `initiating_external_message_id`: `pending:ui:<uuid>`; the Task's `conversation_id` has the same value;
- `parent_conversation_id`: `pending:ui`;
- `agent_session_id`: `pending:task:<uuid>`; the first run replaces it when it starts the Agent Session.

When `DISCORD_TASK_CHANNEL_ID` is unset, a run of a UI-created Task whose `conversation_id` starts with `pending:ui:` makes no Discord calls. A run that has no thread posts no report. When `DISCORD_TASK_CHANNEL_ID` is set, the first run posts a starter message in that channel and opens a thread named after the title. `bindTaskConversation` then updates, in one immediate transaction, `tasks.conversation_id` and the session's `conversation_id`, `parent_conversation_id` (the task channel), and `initiating_external_message_id` (the starter). Each update is guarded on the old `pending:ui:` value and must change exactly one row; otherwise the transaction rolls back. If thread creation fails, the agent deletes the starter and thread when it can, records a `task_thread_failed` Event with detail `task=<id>; run=<id>`, and continues the run without a thread. The IDs stay pending, and the next run tries again.

### Result file

The agent writes `results/<task-id>/<run-id>/result.md` for every completed and failed run whose run folder was created. This includes runs interrupted by shutdown. These runs get no `result.md`: a run that fails before its folder exists (for example "Task unavailable" or an unsafe `results/` or Task directory), a run failed by startup recovery, a cancelled run, and a run whose `result.md` path is an unsafe link. The file contains:

- a heading with the title, or `Task #<id>`;
- the Task and Run IDs, the state, and the ISO start and end times;
- the instruction and the expected output (`Not set.` when empty);
- the full answer, or for a failed run a safe failure reason only;
- the list of other files in the run folder.

`results/`, the Task folder, and the run folder must be real directories inside `results/`. The agent opens `result.md` with `O_NOFOLLOW` and writes it only when it is a regular file with one link, so a planted symlink or hard link fails the run instead. `result.md` is not uploaded to Discord and is not listed in the Discord report.

The UI reads `result.md` for the newest 20 runs of each listed Task, in `/api/ui-data` `taskRuns`. It applies the same folder and link checks, refuses files over 64 KB or with NUL bytes, redacts credential-shaped text, and returns at most 4 MB of result text per response. A run in progress shows "Run in progress".

## Worker rules

The Phase 5 queue durably sets `runtime_started_at` before invoking the Agent Runtime. On restart, stale `processing` user Messages without that boundary return to `pending`; post-boundary Messages fail closed with an uncertain-outcome detail, without dropping their Session binding or replaying the turn (ADR 0002). Stale `memory_reviews` still return to `pending`. A Session processes inbound Messages FIFO, with at most one `processing` Message for that Session. Different Sessions may run independently once the Codex runtime has passed the concurrent-session check; otherwise the worker falls back to one global queue. Process a due `memory_reviews` row only when no user row is pending or processing.

Reset ends the active Session and atomically fails its still-pending and processing inbound Messages plus unsent response chunks. The archived rows and the ended Session's Agent Session ID remain for audit; a later Message may create a new active Session in the same Conversation.

Task Run claims use an immediate transaction. The database index prevents a second processing Task Run in the same Agent Instance. Completion, failure, cancellation, and startup recovery set `completed_at` and update audit fields. Pause prevents new claims but lets an active run finish. `/inoai task cancel` marks an active run cancelled and ends the Task. A UI cancel ends the Task but lets an active run finish and record its result (ADR 0026). Normal Task and Task Run reads exclude soft-deleted rows.

Use a transaction when claiming work (`pending` to `processing`) and when finalizing a response plus its inbound message. The claim must reject a Message if another Message for its Session is already `processing`. A failed Recap retries up to three times later that day, with a one-hour initial delay and exponential backoff. After that it remains `failed` until the next daily cycle. No `jobs` or lock table is needed until more than one process is intentionally supported.

## Deferred deliberately

- Full-text or vector search: inject active global memory plus the active session memory initially; add retrieval only when memory volume makes that insufficient.
- A `memory_sources` join table: one strongest source message plus the review range is enough for v1.
- Guilds, projects, permissions, and configuration tables: V1 reads these boundaries from `.env`. A simple transport-scoped `users` allowlist is intentionally retained for future family access.
- PostgreSQL persistence for Tasks and Task Runs remains deferred; the accepted implementation uses the selected Agent Instance's SQLite database.
