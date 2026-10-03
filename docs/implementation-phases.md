# inoai implementation phases

V1 proves a safe Discord-to-Codex conversation flow, with Claude CLI and OpenCode added as further runtimes in Phases 5a and 5b, using the local CLI's configured capabilities. Phase 6c adds an optional analytics-sync scheduler; it does not make cloud access an operational dependency or accept remote UI access.

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

Phase 5 broadens the Phase 3 single-channel start policy: in the configured server, a new Conversation starts only from an active owner's top-level mention of this bot in an accessible channel other than the online-report channel. Ordinary top-level messages remain ignored; follow-up Messages in that bot's bound thread need no mention. The online-report channel is status-only and never starts a Conversation.

### Tasks

1. Rename `DISCORD_ALLOWED_CHANNEL_ID` to `DISCORD_STATUS_CHANNEL_ID` without a legacy alias, broaden owner top-level mention routing to accessible non-report channels in the configured server, and wire Transport, Database, Agent Runtime, and FIFO worker through `index.ts`.
2. Persist inbound Messages before runtime work begins.
3. Show a compact working indicator and deliver only the completed final response to the source thread, splitting for transport limits; do not post partial assistant text or raw tool output.
4. Persist response chunks and delivery failures.
5. Register guild-scoped native Discord `/inoai status`, `/inoai cancel`, and `/inoai reset` slash commands and handle their owner-only interactions in bound threads; they do not require a bot mention or create Codex turns.
6. Run a focused live Discord smoke test against a private test channel and isolated project using the owner's locally configured bot token.

**Testable outcome:** an allowlisted Discord thread holds a persistent Agent Session across multiple Messages.

Phase 5 acceptance requires deterministic fake-transport/runtime tests, the isolated authenticated read-only Codex concurrency probe, and a focused live Discord smoke test. Keep the token only in an ignored local runtime-home `.env`; never put it in chat, committed files, logs, or SQLite. Phase 8 still owns fresh-deployment, reconnect, crash-recovery, and full end-to-end acceptance.

**Test scenarios:**

- Two user Messages arriving together are answered in FIFO order.
- Two Conversations can make progress independently while one Conversation never has overlapping runtime turns.
- An authenticated, read-only two-session Codex probe in an isolated temporary project validates cross-Conversation concurrency without a Discord bot token. Until it passes, use global serialization; a failed check keeps that fallback without dropping queued Messages.
- A duplicate Discord gateway event produces no duplicate runtime turn.
- Restarting the app requeues only work known not to have reached the Agent Runtime. Work whose runtime outcome is uncertain fails closed without replay; Session mapping is preserved.
- An idle thread retains its Agent Session until an explicit `/inoai reset`.
- `/inoai reset` cancels an active turn, fails queued Messages without running them, retains the archive, and starts a new Agent Session on the next Message; an uncertain active outcome is reported, not replayed.
- Native `/inoai` controls work in a bound thread without `@<bot-label>` and are rejected outside the owner's bound thread; control interactions never enter the Codex Message queue.
- A reply to an earlier Message retains its quoted context when processed later.
- A long response is split safely and stored as linked agent Messages.
- An ambiguous Discord send is recorded as uncertain and is not automatically resent on restart; the response remains archived in SQLite.
- With a real bot in a private test channel, the owner can start a thread, receive a Codex answer, continue the same Agent Session, and exercise status, cancel, and reset; verify that the Discord Messages match the SQLite archive. Use only a disposable project and read-only prompts.
- The online-report channel posts the startup health message but ignores conversation-start mentions; an owner mention in another accessible channel starts a Conversation, while unmentioned top-level Messages do not.

## Phase 5a — Claude runtime

**Purpose:** add Claude CLI as a second Agent Runtime with the same Discord, SQLite, queue, approval, and retry behavior as Codex, using the owner's local Claude subscription sign-in and no Anthropic API key.

Match Codex behavior unless a Claude difference forces otherwise. Each runtime home still selects exactly one provider; the recommended Claude deployment is a separate `.inoai-connect-claude/` home with its own Discord bot. Phases 6–8 apply to both providers. See [ADR 0007](adr/0007-claude-matches-codex-fail-closed-approvals.md) and [ADR 0008](adr/0008-drive-claude-through-headless-cli.md).

### Tasks

1. Spike the installed `claude` CLI headless contract before adapter work: `-p --output-format stream-json` event and final-result shapes, `--session-id`/`--resume`, `--append-system-prompt`, how a permission prompt not covered by the owner's settings is denied and reported in `-p` mode, how to read the active credential source, SIGINT cancellation, and whether probe sessions can avoid persisting. Record findings; if denials or the credential source cannot be observed reliably, stop and ask the owner before choosing another mechanism.
2. Accept `AGENT_PROVIDER=claude` and an optional `CLAUDE_MODEL` (blank uses the CLI default) in `.env` validation and `.env.sample`. Add no permission, sandbox, approval, or credential keys.
3. Add the minimal provider seam: each adapter supplies a display name and login hint used by shared failure and recovery notices, and `index.ts` selects the runtime, its approval handling, and its concurrency probe with a simple `switch`.
4. Implement the Claude adapter behind `AgentRuntime`: spawn the installed `claude -p --output-format stream-json` per Turn in the project path; assign the Agent Session UUID at creation, start the first Turn with `--session-id` and later Turns with `--resume`; pass `agent.md` through `--append-system-prompt` with `--system-prompt-snapshot off` on every Turn so edits reach existing Sessions; pass `--permission-prompts none` so prompts fail closed explicitly; pass `--model` only when `CLAUDE_MODEL` is set; leave settings, MCP servers, skills, `CLAUDE.md`, permission rules, and permission mode to the owner's Claude configuration.
5. Map stream events to progress and the final answer; map authentication, usage, pre-start, idle-timeout (5 minutes without an event), cancellation, and uncertain outcomes to the existing failure kinds, retrying only per [ADR 0002](adr/0002-retry-only-proven-safe-runtime-turns.md). Cancel with SIGINT.
6. Fail closed on every Claude permission prompt per ADR 0007: the Turn proceeds with the CLI's denial, inoai records a non-secret `approval_unsupported` Event, and posts a fixed notice to use local Claude for the blocked action. Never add allow rules, auto-allow tools, or change the permission mode.
7. At startup, ask the CLI which credential it will use and refuse to start unless it is the owner's interactive subscription login (`/login`), naming the overriding source locally. Never edit shell, settings, or credentials.
8. Refuse a Turn whose Session `agent_provider` differs from the configured provider: fail the Message and post a fixed notice that `/inoai reset` or a new thread starts a session with the current provider.
9. Add a tool-free Claude concurrency probe: two ephemeral sessions in a disposable project with tools disabled must both stream before either completes; otherwise use global FIFO.
10. Make the wrong-bot `/inoai` rejection explain that the thread belongs to another inoai bot.
11. Add Claude setup and validation instructions and the subscription-login policy note to the README.
12. Run a focused live Discord smoke test from an isolated `.inoai-connect-claude/` home with its own bot token in a private test channel against a disposable project.

**Testable outcome:** a Claude-backed Agent Instance holds a persistent Agent Session across Discord thread Messages with the same safety behavior as Codex.

Phase 5a acceptance requires deterministic fake-CLI tests, the authenticated tool-free Claude concurrency probe, and the live Discord smoke test. Keep the bot token only in an ignored runtime-home `.env`.

**Test scenarios:**

- `AGENT_PROVIDER=claude` validates; an unsupported provider or malformed `CLAUDE_MODEL` fails before startup.
- Startup succeeds with Claude subscription sign-in and refuses, naming the source, when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`, a cloud provider, or an Anthropic profile would supply the credential.
- A normal question returns a final answer; a follow-up resumes the same Claude Agent Session, including after an inoai restart.
- `agent.md` reaches every Turn without replacing Claude's default system prompt; a configured local skill or read-only MCP tool is available.
- A tool call needing a permission prompt is denied without hanging; the owner gets the fixed notice, and no actionable control, pending approval row, or raw tool input is stored or sent.
- Expired authentication and exhausted usage produce Claude-worded notices with the Claude login hint.
- A pre-start failure retries at most three times; a timeout or process loss after the Turn may have begun is not replayed.
- `/inoai cancel` and `/inoai reset` stop an active Claude Turn and leave the Conversation usable.
- A Codex-bound thread in a home switched to `claude` refuses the Turn with the fixed notice, and `/inoai reset` then starts a Claude session in that thread.
- The probe enables per-session concurrency only when both sessions overlap; sequential or failed runs keep global FIFO without dropping queued Messages.
- A token-shaped literal in a prompt or tool input is never copied into SQLite, logs, or Discord beyond the archived owner Message.
- With a real Claude bot in a private test channel, the owner can start a thread, receive a Claude answer, continue the same Agent Session, and exercise status, cancel, and reset; Discord Messages match the SQLite archive.

## Phase 5b — OpenCode runtime

**Purpose:** add OpenCode as a third Agent Runtime with the same Discord, SQLite, queue, approval, and retry behavior as the Claude adapter, using whatever provider and model the owner's OpenCode is configured with.

Match the Claude adapter's behavior unless an OpenCode difference forces otherwise. OpenCode homes always use global FIFO (no concurrency probe). There is no model setting and no credential guard ([ADR 0009](adr/0009-opencode-uses-its-configured-provider.md)); today the configured default is a free OpenCode Zen model, which sends prompts and project context to opencode.ai. The recommended deployment is a separate `.inoai-connect-opencode/` home. Phases 6–8 apply to all three providers.

### Tasks

1. Spike the installed `opencode` (v2.0.22 at planning time) headless contract with a few short, harmless prompts against the configured free Zen model in a disposable project: `run --format json --standalone` event shapes for text, tool use, errors, and the session ID; whether `--session` accepts a pre-assigned `ses_` ID and resumes across standalone runs; how to check that a session exists before resuming without silently creating it; whether `OPENCODE_CONFIG_CONTENT` with `instructions` reaches a standalone run (it does not; see the spike); how an auto-rejected permission appears on stdout/stderr; SIGINT and exit codes; free-tier rate-limit and error shapes; standalone startup time; and how to remove probe/spike sessions. Record findings; if standalone cannot resume sessions or is unreasonably slow, stop and ask the owner.
2. Accept `AGENT_PROVIDER=opencode` in `.env` validation and `.env.sample`, add `opencode` to the provider-mismatch display map, and add the `opencode` branch to the provider switch (global FIFO, no probe).
3. Implement the OpenCode adapter behind `AgentRuntime` (display name `OpenCode`, login hint `opencode auth login`): spawn the installed `opencode run --format json --standalone` per Turn without a shell in the project path; deliver `agent.md` as a delimited "inoai operating instructions (not a user message)" block prepended to every Turn's stdin prompt (OpenCode ignores `instructions` config; owner decision after the spike); create the session on the first Turn without `--session`, store the streamed `sessionID`, and resume with `--session` afterwards, first checking — once per process, for a session not yet seen to succeed — that it exists with `opencode api --standalone GET /api/session/<id>`, failing closed with `session_missing` when the stored session no longer exists; build the answer from completed text events; classify from exit code and `error` events; map rate limits to `usage`, unknown failures to `uncertain`, retry only never-started Turns (ADR 0002); cancel with SIGINT; 5-minute idle timeout.
4. Fail closed on every OpenCode permission request: never pass `--auto`, `--yolo`, or `--dangerously-skip-permissions`; detect OpenCode's headless auto-rejection and post one fixed notice per Turn with a count-only `approval_unsupported` Event, as for Claude.
5. Add OpenCode setup, PATH, data-flow, and billing notes to the README.
6. Run a focused live Discord smoke test from an isolated `.inoai-connect-opencode/` home in a disposable deployment folder.

**Testable outcome:** an OpenCode-backed Agent Instance holds a persistent Agent Session across Discord thread Messages with the same safety behavior as the Claude adapter.

Phase 5b acceptance requires deterministic fake-CLI tests and the live Discord smoke test.

**Test scenarios:**

- `AGENT_PROVIDER=opencode` validates; startup fails clearly when `opencode` is not on PATH, releasing the runtime lock.
- A normal question returns a final answer; a follow-up resumes the same OpenCode session, including after an inoai restart.
- `agent.md` reaches every Turn as a delimited prompt block alongside the project's native `AGENTS.md`; edits apply on the next Turn.
- A stored session that no longer exists fails with `session_missing` and the reset notice, never a silently new session.
- A tool call OpenCode auto-rejects yields one fixed notice and a count-only Event; no approval controls, rows, or raw tool input are stored or sent.
- Rate-limit and authentication results map to fixed OpenCode-worded notices, and the authentication notice also covers a free-tier refusal; only never-started Turns retry; a timeout or process loss after the Turn may have begun is not replayed.
- `/inoai cancel` and `/inoai reset` stop an active OpenCode Turn and leave the Conversation usable.
- A Codex- or Claude-bound thread in an OpenCode home refuses the Turn with the mismatch notice.
- With a real bot in a private test channel, the owner can start a thread, receive an OpenCode answer, continue the same Agent Session, and exercise status, cancel, and reset; Discord Messages match the SQLite archive.

## Phase 6 — Daily Memory Review

**Purpose:** distill stable preferences and project decisions from the local archive without adding chat noise.

A Recap covers one Agent Session's archived Messages since that Session's prior Recap. Reviews run text-only in throwaway runtime sessions ([ADR 0010](adr/0010-memory-reviews-run-text-only-in-throwaway-sessions.md)). Claude is fully supported and live-verified. Codex review support is implemented with the read-only sandbox and approval policy `never` settings but disabled, because a Codex review thread still loads the owner's MCP servers; Codex and OpenCode homes skip reviews and record the skip without moving any cursor.

### Tasks

1. Spike the installed Claude CLI's text-only review mode in a disposable project: all tools disabled, no MCP servers, no session persistence, the review prompt on stdin, and how reliably a real model returns the required JSON (including fenced or prefixed output). Confirm no tool runs when the transcript contains tool-triggering or instruction-like text.
2. Add one narrow `AgentRuntime` review method for a single text-only, throwaway prompt returning text. Implement it for Claude (restricting flags from the spike, plus `--safe-mode` and `--system-prompt` with inoai's fixed review instructions replacing the default prompt, failing closed if init still reports memory paths, MCP servers, or tools; owner decisions) and Codex (ephemeral thread, read-only sandbox, approval policy `never`); OpenCode reports reviews as unsupported. Never use a thread's own Agent Session.
3. Build the review engine: select completed owner and agent Messages in the Session's range (excluding inoai's fixed notices), redact secret-like text, split into chronological `MEMORY_REVIEW_MAX_CHARS` windows with role labels, collect bounded per-window notes in memory, then run a final aggregation with the notes, the owner's explicit memory requests detected by inoai's own signal rule (redacted and bounded, so a request dropped from the notes is not lost), active Memory, and recent agent-wide Recaps within a fixed character budget. Parse a JSON result of one Recap plus `add`, `update`, `delete`, or `ignore` actions.
4. Validate every action deterministically: an explicit Memory Signal must cite an owner-authored Message in range containing a remember-style phrase; a recurrence must cite at least two prior completed Recaps; `update`/`delete` must name an existing active `origin = review` Memory (Manual Memory Entries are read-only to reviews); source IDs must be in range; bodies are length-capped and pass the secret filter. Drop failing actions as `ignored` with a non-secret reason and apply the rest. Commit the Recap, Memory changes, provenance, and cursor in one transaction.
5. Schedule the daily cycle: after `MEMORY_REVIEW_TIME` local time, run at most one cycle per local date (recorded as a `memory_review_cycle` Event), catching up once at startup or wake if the time has passed. Enqueue one review per Session with new completed Messages, including ended Sessions with an unreviewed tail. Start a review only when no user Message is pending or processing; a user Message arriving mid-review cancels it and returns it to `pending` without consuming an attempt (recorded as a deferral; after five deferrals in a day the review waits for the next cycle). Retry failed attempts up to three times that day after 1, 2, and 4 hours, then leave the review `failed` until the next cycle. Reviews never post to the chat transport.
6. Update the README and status for Memory Review behavior, data flow, and per-runtime support.
7. Run a live seeded review on Claude against a disposable archive.

**Testable outcome:** new archive content can update durable Memory once per day, while ordinary chat work remains higher priority.

Phase 6 acceptance requires deterministic fake-runtime tests and one live seeded Claude review; no Discord run is required because reviews are silent.

**Test scenarios:**

- A Session with no new Messages creates no Recap; a cycle runs at most once per local date across restarts, and a missed scheduled time is caught up once at startup.
- A Recap covers only Messages newer than that Session's prior completed Recap; after a reset the ended Session's tail and the new Session are recapped separately.
- An oversized range is reviewed in chronological windows and advances the cursor only after the whole review commits.
- An owner's explicit "remember" request becomes Memory with source provenance; quoted or agent-authored "remember" text does not.
- An ordinary one-off item does not become Memory; a pattern cited across at least two prior Recaps may.
- A secret-like value, transient request, quoted instruction, or unconfirmed model claim is ignored; a proposed change to a Manual Memory Entry is ignored with a reason.
- A user Message at the scheduled time runs before the review; a user Message mid-review defers it without consuming an attempt.
- A failed or unparseable review retries no more than three times in the same day and creates no Discord message.
- A review runs in a throwaway session with tools disabled and never in the thread's own Agent Session; Codex and OpenCode homes record a skip and keep their cursors.
- Live: a seeded Claude archive with an owner "remember X", a quoted fake instruction, a fake secret, and a tool-triggering phrase yields Memory for X with provenance, ignores the rest, and runs no tool.

## Phase 6b — Codex Memory Review verification

**Purpose:** verify the Phase 6 review path against the real Codex CLI without weakening its fail-closed security boundary.

Phase 6b uses synthetic, secret-free archived Messages and no Discord run. The probe includes instruction-like and tool-triggering transcript text. The 2026-10-03 probe against `codex-cli 0.159.3` observed 11 MCP startup notifications (6 `starting`, 5 `ready`) in the authenticated read-only, approval-`never`, ephemeral app-server session. Although the turn made no tool request and changed no disposable project files, MCP absence was not proven, so Codex review support remains disabled. The existing wiring records a non-secret skip and leaves the review cursor unchanged. If a future probe proves a tool/MCP-free session, the boundary can be revisited.

### Tasks

1. Probe the installed Codex CLI with a synthetic injection-like review fixture and capture whether its effective session is tool/MCP-free.
2. If the probe is safe, enable and test Codex review execution; otherwise preserve the existing skip path and document the blocker.
3. Run the Phase 6 review-engine acceptance suite against Codex-compatible behavior, including cursor preservation on failure and no secret leakage.
4. Update the runtime documentation and ADR with the verified result.

**Testable outcome:** Codex Memory Review remains explicitly skipped with evidence and an unchanged cursor until a tool/MCP-free throwaway session is proven; no Discord access is required.

## Phase 6c — BigQuery analytics sync

**Purpose:** export an analytics-safe, one-way copy of local SQLite data to BigQuery without making cloud access an operational dependency.

SQLite remains the operational source of truth. Sync is optional, asynchronous, and configurable; an instance without BigQuery configuration or Google Application Default Credentials continues to run normally. Multiple runtime homes share BigQuery tables and identify their rows with a stable generated `agent_instance_id` and a non-unique `agent_name` (defaulting to the runtime-home folder name). Exported text uses the existing secret-redaction rules; raw tool input/output and credentials are never exported. Soft deletes are represented as tombstones rather than physical deletes. Sync failures are recorded locally and retried without delaying Discord Turns or Memory Reviews.

### Tasks

1. Add persistent runtime metadata for `agent_instance_id` and configurable `agent_name`.
2. Add optional BigQuery configuration and an incremental, idempotent exporter for Conversations, Sessions, Messages, Memory, Recaps, and non-secret Events.
3. Add local sync watermarks, retry/backoff, soft-delete propagation, and non-blocking failure events.
4. Document Google ADC setup for repository clones and verify the exporter with a disposable BigQuery test project or documented offline fallback.
5. Add analytics schema/partitioning conventions using a configurable project and dataset, with tables clustered by `agent_instance_id`.

**Testable outcome:** configured instances incrementally export redacted analytics data to BigQuery; unconfigured or unavailable BigQuery never prevents normal local operation.

**Current implementation boundary:** local metadata, configuration validation, table definitions, exporter, watermarks, retry state, scheduler, and fake-sink acceptance are implemented. The production `@google-cloud/bigquery` client uses ADC and is constructed from configured project settings; `src/index.ts` starts the scheduler after transport startup and stops it during shutdown. No live cloud credentials are required by the offline test suite; a live export still requires host ADC, IAM, project, and dataset setup.

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
3. Verify that a tool action requiring approval follows the configured Codex, Claude, or OpenCode policy without inoai bypassing it.
4. Create a local, SQLite-consistent daily backup after the recap pass and keep three rotating snapshots outside Git.
5. Package the core as a macOS single executable with the sibling Electron bundle and verify a fresh deployment-folder bootstrap.

**Testable outcome:** inoai can run continuously as a locally deployable personal Discord assistant with durable archive and daily silent Memory Review.

**Test scenarios:**

- Disconnect/reconnect Discord without duplicate online messages or duplicate Message processing.
- Stop the process during a runtime turn and recover safely on restart.
- Confirm a tool action requiring approval is declined through the selected runtime's protocol, produces only a fixed safe Discord notice, and is never silently elevated or exposed as an actionable Discord control.
- Restore each rotated local backup and confirm archived Conversations, Recaps, and Memory remain available.
- Run the packaged macOS core in an empty deployment folder; it initializes only `.inoai-connect/` and launches the sibling Electron UI with `inoai ui`.

## Deferred backup direction

V1 stores three rotating, SQLite-consistent snapshots on the same machine. A later local-network backup phase will copy those snapshots or a fresh SQLite backup to a Linux machine on the same network. It must not expose the archive outside the local network.

## Deferred task direction

Introduce Tasks only after V1 is proven. A Task will own a dedicated Conversation and Agent Session; user messages in that thread steer the Task's next run rather than start independent Turns. Define its schema, iteration budget, task-state record, and cancellation semantics then.
