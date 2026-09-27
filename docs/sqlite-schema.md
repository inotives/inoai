# inoai SQLite schema

This is the initial SQLite schema for the chat-to-agent bridge. Times are Unix seconds. External platform identifiers are `TEXT` to avoid JavaScript integer precision loss.

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
  external_message_id TEXT NOT NULL,
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
  completed_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
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
```

## Audit fields

Every persisted table has `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`, and `deleted_by`. Actor fields are normalized text such as `system`, `user:42`, `transport:discord`, or `agent:codex`; this supports automated and human actions without a second actor table. `deleted_at` and `deleted_by` form a soft-delete pair: records are not physically removed in V1, and ordinary queries exclude soft-deleted rows. Soft-deleted records are hidden with no restore action in V1.

## How the tables work

- A transport-specific start action creates one `sessions` row and one initial `messages` row. `agent_provider` and `agent_session_id` identify the selected CLI runtime session; `conversation_id` is the transport conversation boundary (a Discord thread in v1).
- `users` is the transport-scoped allowlist. Startup upserts the configured owner as its first active `owner` record; V1 creates no other active User records.
- Every eligible conversation message is inserted into `messages` before it is processed and references its User. The worker claims the oldest `user`/`pending` row. Agent responses are stored as `agent` rows, one per transport message chunk, linked by `in_reply_to_message_id`.
- `events` stores health checks, connection changes, session lifecycle events, and errors. Its `session_id` is nullable so `inoai is online` can be recorded without a conversation.
- A `memory_reviews` row is a timestamped recap entry. It records the source range since that Conversation's last completed recap, its concise recap text, and any Memory actions. Only normal chat work runs ahead of it.
- `memories` contains durable Manual Memory Entries and reviewed entries in one agent-wide shared namespace. A Manual Memory Entry identifies its owner User when available; a reviewed entry identifies its source Message and Recap. `origin` is provenance only: all active Memory has the same retrieval and review behavior. Soft-delete changes state without removing history.
- `approvals` persists a user-safe summary of a pending Codex permission request and its final decision. It lets the runtime recover an approval relay after an app restart without storing raw tool output. A pending approval expires after 24 hours; expiration is terminal and requires a new request.

## Worker rules

On startup, move stale `processing` rows in both `messages` and `memory_reviews` back to `pending`. A Session processes inbound Messages FIFO, with at most one `processing` Message for that Session. Different Sessions may run independently once the Codex runtime has passed the concurrent-session check; otherwise the worker falls back to one global queue. Process a due `memory_reviews` row only when no user row is pending or processing.

Use a transaction when claiming work (`pending` to `processing`) and when finalizing a response plus its inbound message. The claim must reject a Message if another Message for its Session is already `processing`. A failed Recap retries up to three times later that day, with a one-hour initial delay and exponential backoff. After that it remains `failed` until the next daily cycle. No `jobs` or lock table is needed until more than one process is intentionally supported.

## Deferred deliberately

- Full-text or vector search: inject active global memory plus the active session memory initially; add retrieval only when memory volume makes that insufficient.
- A `memory_sources` join table: one strongest source message plus the review range is enough for v1.
- Guilds, projects, permissions, and configuration tables: V1 reads these boundaries from `.env`. A simple transport-scoped `users` allowlist is intentionally retained for future family access.
- Scheduled tasks and task-run ledgers: add them only in the later task phase, after normal conversation and Memory review behavior is proven.
