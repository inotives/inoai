# inoai implementation phases

V1 proves a safe Discord-to-Codex conversation flow using the local CLI's configured capabilities. It does not add a scheduler or accept remote UI access.

## Phase 1 — Scaffolding

**Purpose:** establish a runnable TypeScript project with safe local configuration and repeatable checks.

### Tasks

1. Create `package.json`, `tsconfig.json`, TypeScript scripts, and a minimal test runner.
2. Add `.gitignore` for `.inoai-connect*/`, `dist/`, and `node_modules/`.
3. Create the portable-core bootstrap: resolve `.inoai-connect/` under the launch folder and initialize it from bundled `.env`, `agent.md`, and SQLite templates when absent.
4. Create `.env.sample` with the required Discord owner, runtime, and 06:00 review configuration.
5. Add a configuration loader that validates values without connecting to Discord or Codex.
6. Add `inoai ui` to launch the sibling Electron bundle without placing it in `.inoai-connect/`.
7. Write the README setup and local-run instructions.

**Testable outcome:** a clean checkout can install dependencies and validate a complete local configuration without contacting an external service.

**Test scenarios:**

- Valid `.env` passes configuration validation.
- Each missing required setting reports its exact variable name.
- Starting in an empty deployment folder creates `.inoai-connect/` without overwriting an existing runtime home.
- A second core refuses to start for an already locked runtime home, while an explicit `.inoai-connect-2` runtime home can initialize and start independently.
- `inoai ui` launches the sibling Electron bundle and leaves `.inoai-connect/` data unchanged.
- Automated tests use isolated temporary runtime homes and never access the repository-root development `.inoai-connect/` directory.
- An unsupported `CHAT_PROVIDER` or `AGENT_PROVIDER` fails before startup.
- `.inoai-connect/` does not appear in Git status after a local run.

## Phase 2 — SQLite archive and queue

**Purpose:** make SQLite the durable source of truth before connecting an external transport.

### Tasks

1. Implement initial schema creation from [SQLite schema](sqlite-schema.md).
2. Configure SQLite for local core-plus-UI access with WAL journaling and a bounded busy timeout.
3. Implement Session, Message, Event, Memory, and Memory Review reads/writes with uniform audit fields and soft-delete filtering.
4. Implement the transport-scoped User allowlist and owner bootstrap from configuration.
5. Implement atomic claim/finalize operations for a per-Session FIFO Message worker.
6. Recover stale `processing` rows at startup.
7. Add a small local management CLI for Manual Memory Entry create/list/soft-delete operations.

**Testable outcome:** archived Messages survive a restart and one Session worker can claim them without duplicates or same-Session overlap.

**Test scenarios:**

- Opening a new database creates all v1 tables and indexes.
- A core writer and UI reader can use the same local database without a locked-database failure under normal short transactions.
- Owner bootstrap creates one active owner User and does not duplicate it on restart.
- Every persisted table records `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`, and `deleted_by`; normal queries exclude soft-deleted rows.
- Re-delivering the same transport/workspace/message ID stores one Message only.
- Two pending Messages are claimed oldest-first.
- A stale `processing` Message becomes `pending` after simulated restart.
- Two Messages for one Session cannot both become `processing`; different Sessions are eligible independently.
- If concurrent-session validation fails, all pending Sessions continue through one global FIFO queue.
- Memory Review cursors select only Messages newer than the last completed review.
- A local Manual Memory Entry persists with `origin = manual` and can be soft-deleted without an Agent Runtime call.

## Phase 3 — Discord transport

**Purpose:** receive an allowlisted Discord request and create a clean Conversation boundary.

### Tasks

1. Implement the Discord Chat Transport adapter and gateway lifecycle.
2. On ready, post `inoai is online` in the configured channel and persist the Event.
3. Resolve incoming Discord identities through the User allowlist; accept only an active User's top-level `@inoai` mention and create its Discord thread and Conversation record.
4. Accept ordinary messages from the allowlisted user inside a bound thread.
5. Ignore bot messages, unmentioned top-level messages, incorrect users, guilds, and channels.

**Testable outcome:** Discord events map deterministically to archived Conversation Messages without invoking an Agent Runtime.

**Test scenarios:**

- The configured channel receives exactly one online health message per app process start and none for later reconnects in that process.
- An allowlisted top-level mention creates one thread and one Conversation.
- A second top-level mention creates a separate thread and Conversation.
- A non-allowlisted user, wrong channel, and bot message create no database Message.
- A family member's Discord user ID is rejected in V1, even when they can read the channel.
- A valid thread message queues one user Message without needing a new mention.
- A top-level mention for a different bot identity, or a message in another bot's thread, creates no Conversation and queues no Message.
- A cross-agent mention inside a bound thread remains a turn for the thread-owning agent only; bot-authored messages never queue work.
- A top-level message mentioning multiple configured agent bots creates no Conversation or thread for any bot.

## Phase 4 — Codex runtime

**Purpose:** connect the Codex adapter using the local ChatGPT sign-in and its configured skills, MCP servers, and permission policy, with no OpenAI API key.

### Tasks

1. Implement the provider-neutral Agent Runtime interface and its Codex adapter.
2. Verify local Codex authentication before accepting work.
3. Start, continue, cancel, and stream an Agent Session from the configured project path.
4. Preserve the Codex CLI's configured skills, MCP servers, and permission/sandbox policy; do not add a wrapper-level tool allowlist or approval bypass.
5. Fail closed on every Codex approval request in V1: return a protocol-correct decline, record only a non-secret outcome, and tell the owner that the action needs local Codex. Do not post **Approve**/**Reject** buttons, persist raw request details, add a command allowlist, or silently change Codex's configured sandbox/approval policy. Codex CLI `0.157.1` does not provide a complete safe preview for these Discord prompts. Do not replay an interrupted turn after restart.
6. Record runtime failures as Events without exposing credentials or raw tool traces.
7. Retry a failed or timed-out turn up to three times with bounded backoff only when the runtime turn never started or is proven to have had no side effects. If execution may have begun and its outcome is uncertain, fail closed after that attempt and ask for a fresh request; publish at most one concise Discord failure and no duplicate answer.

**Testable outcome:** a local, ChatGPT-authenticated Codex session can answer a project question and use the configured Codex capabilities without inoai changing their permissions.

**Test scenarios:**

- Startup succeeds with ChatGPT CLI authentication and no `OPENAI_API_KEY`/`CODEX_API_KEY`.
- A normal question returns a streamed answer.
- A configured local skill or read-only MCP tool is available to the Codex session.
- Every current Codex approval method receives a protocol-correct decline without hanging the turn; the owner gets a fixed safe notice, and no actionable Discord controls or pending approval row is created.
- A command containing a token-shaped literal is never copied into SQLite, logs, or Discord. Legacy saved pending approvals are failed closed on restart and their saved previews redacted; the interrupted turn is not replayed. Recovery records one safe Event and claims its Discord notice before sending, so a crash can omit the notice but cannot duplicate it.
- Expired authentication and exhausted usage become clear local/Discord-safe failure states.
- A pre-start failure may retry at most three times with bounded backoff and emits one failure notice if exhausted.
- A timeout or process loss after execution may have begun is not replayed automatically; its uncertain outcome is recorded and the owner is asked for a fresh request.
- Cancellation stops the active runtime turn and leaves the Conversation usable.

## Phase 5 — End-to-end conversation worker

**Purpose:** deliver reliable Discord-thread conversations through the SQLite queue to the Agent Runtime.

### Tasks

1. Wire Transport, Database, Agent Runtime, and FIFO worker through `index.ts`.
2. Persist inbound Messages before runtime work begins.
3. Stream progress and final responses back to the source thread, splitting for transport limits.
4. Persist response chunks and delivery failures.
5. Add `/inoai status`, `/inoai cancel`, and `/inoai reset` controls.

**Testable outcome:** an allowlisted Discord thread holds a persistent Agent Session across multiple Messages.

**Test scenarios:**

- Two user Messages arriving together are answered in FIFO order.
- Two Conversations can make progress independently while one Conversation never has overlapping runtime turns.
- A failed concurrent-session check falls back to global serialization without dropping queued Messages.
- A duplicate Discord gateway event produces no duplicate runtime turn.
- Restarting the app requeues only work known not to have reached the Agent Runtime. Work whose runtime outcome is uncertain fails closed without replay; Session mapping is preserved.
- An idle thread retains its Agent Session until an explicit `/inoai reset`.
- A reply to an earlier Message retains its quoted context when processed later.
- A long response is split safely and stored as linked agent Messages.

## Phase 6 — Daily Memory Review

**Purpose:** distill stable preferences and project decisions from the local archive without adding chat noise.

### Tasks

1. Schedule a local 06:00 host-time maintenance timer.
2. Enqueue one review per Conversation with new archived Messages.
3. Supply the transcript range since the prior recap in chronological 20,000-character windows, plus existing relevant Memory, to the Agent Runtime; aggregate its bounded internal notes at the end.
4. Compare the recap with relevant prior Recaps and active Memory; persist one timestamped recap plus validated Memory actions transactionally only when an explicit Memory Signal or useful recurrence exists.
5. Retry a failed Recap up to three times later that day with bounded backoff, then record its final state silently in SQLite.

**Testable outcome:** new archive content can update durable Memory once per day, while ordinary chat work remains higher priority.

**Test scenarios:**

- A Conversation with no new Messages creates no recap.
- A recap covers only Messages newer than the prior completed recap.
- An oversized archive range is reviewed in chronological windows and advances the recap cursor only after all windows succeed.
- A review can add a user-confirmed preference with source provenance.
- A user request to remember, take note of, or treat a fact as important becomes a Memory candidate during the next recap.
- An ordinary one-off recap item does not become Memory; a useful repeated pattern may.
- A secret-like value, transient request, quoted instruction, or unconfirmed model claim is ignored.
- When a user Message arrives at 06:00, it runs before the review.
- A failed review remains retryable and creates no Discord message.
- A failed review retries no more than three times in the same day.

## Phase 7 — Separate Electron analytics UI

**Purpose:** provide a separately started Electron UI to inspect archived conversations, Memory, queue health, and review results, and to manage Manual Memory Entries.

### Tasks

1. Build the Tailwind renderer inside a separate Electron application pointed at a selected `.inoai-connect/` runtime home.
2. Keep SQLite access in the Electron main process and expose only narrow typed operations through a preload bridge.
3. Add a native **Load SQLite** action that validates a selected `inoai.sqlite` and switches the active Agent Instance view without reading its `.env`.
4. Show connection health, queue state, recent Conversations, Message timelines, active Memory, and Memory Review outcomes.
5. Add local Manual Memory Entry create/soft-delete controls that write SQLite only and never invoke the Agent Runtime.
6. Exclude credentials, environment values, and raw runtime tool output from all UI data.

**Testable outcome:** the owner can inspect inoai state locally without exposing data to the network or adding Discord noise.

**Test scenarios:**

- The UI can inspect only the explicitly selected local runtime home and never exposes SQLite remotely.
- The UI reads the selected SQLite file directly; the core exposes no dashboard API.
- The renderer has Node integration disabled and cannot access the filesystem except through the preload bridge.
- Loading a valid SQLite file switches all analytics to that Agent Instance; an invalid schema or non-runtime file is rejected without exposing its contents.
- A Conversation timeline matches archived SQLite Messages.
- Active Memory and review outcomes appear with source and timestamp.
- UI data access never returns bot tokens, runtime credentials, or raw tool output.
- A Manual Memory Entry created from the Electron UI persists with `origin = manual` and does not invoke an Agent Runtime.

## Phase 8 — V1 acceptance and operational hardening

**Purpose:** verify that the assembled system behaves predictably under expected failures.

### Tasks

1. Run the end-to-end acceptance scenarios from a fresh local setup.
2. Verify restart behavior for Discord reconnect, SQLite recovery, and unfinished worker state.
3. Verify that a tool action requiring approval follows the configured Codex policy without inoai bypassing it.
4. Create a local, SQLite-consistent daily backup after the recap pass and keep three rotating snapshots outside Git.
5. Package the core as a macOS single executable with the sibling Electron bundle and verify a fresh deployment-folder bootstrap.

**Testable outcome:** inoai can run continuously as a locally deployable personal Discord assistant with durable archive and daily silent Memory Review.

**Test scenarios:**

- Disconnect/reconnect Discord without duplicate online messages or duplicate Message processing.
- Stop the process during a runtime turn and recover safely on restart.
- Confirm a tool action requiring approval is declined through Codex's protocol, produces only a fixed safe Discord notice, and is never silently elevated or exposed as an actionable Discord control.
- Restore each rotated local backup and confirm archived Conversations, Recaps, and Memory remain available.
- Run the packaged macOS core in an empty deployment folder; it initializes only `.inoai-connect/` and launches the sibling Electron UI with `inoai ui`.

## Deferred backup direction

V1 stores three rotating, SQLite-consistent snapshots on the same machine. A later local-network backup phase will copy those snapshots or a fresh SQLite backup to a Linux machine on the same network. It must not expose the archive outside the local network.

## Deferred task direction

Introduce Tasks only after V1 is proven. A Task will own a dedicated Conversation and Agent Session; user messages in that thread steer the Task's next run rather than start independent Turns. Define its schema, iteration budget, task-state record, and cancellation semantics then.
