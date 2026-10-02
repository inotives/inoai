# Discord-controlled Codex CLI harness: initial proposal

## Purpose

Build a small, personal Discord bot that lets an allowlisted owner continue Codex CLI conversations from Discord. It must use the locally signed-in ChatGPT account and its included Codex usage--not the OpenAI API and not an API key.

The bot is a remote conversation surface for a local Codex installation. It is not a multi-tenant agent service, a general shell bot, or a replacement for Codex's permission model.

## MVP outcome

In the configured private Discord server, the owner can post a top-level `@inoai` task in a channel the bot can access, excluding the status-only online-report channel. inoai creates a dedicated Discord thread, binds a fresh Codex session to it, and replies there. Every later allowlisted user message in that thread continues the same Codex session without another mention. Ordinary top-level messages do not invoke Codex.

```text
private Discord server
        |
        v
Discord bot + local bridge process
        |
        v
Codex app-server / Codex CLI on the owner's machine
        |
        v
local project directory and existing ChatGPT CLI sign-in
```

## Runtime flow

1. The portable core starts in a deployment folder, locates the selected `.inoai-connect*` runtime home (or creates it from its bundled template), then loads and validates its `.env` and `agent.md`.
2. It opens that runtime home's `inoai.sqlite` and applies the initial schema.
3. It connects to Discord using the bot token.
4. Once Discord first reports the bot ready for this app process, it posts `inoai is online` in `DISCORD_STATUS_CHANNEL_ID` as the startup health check and records that event in SQLite.
5. It then remains running on Discord's gateway event loop, waiting for eligible `@inoai` mentions and replies. On each incoming event, it routes the turn to its bound Codex session and writes inbound messages, outbound answers, and lifecycle events to SQLite.

If configuration, SQLite initialization, or Discord connection fails, the app must not claim to be online. It should log the local failure and exit so the process supervisor can restart it.

This is event-driven, not a polling loop: Discord pushes message events to the connected bot. The Node process stays alive until it receives a shutdown signal or loses the connection; the Discord client handles reconnecting before the app declares itself unavailable. A reconnect in the same app process does not post another online message; a new app process does.

## Authentication and billing boundary

- Authenticate Codex interactively on the host with **Sign in with ChatGPT** before starting the bridge.
- Do not configure `OPENAI_API_KEY`, `CODEX_API_KEY`, or any API-backed fallback.
- Discord requires its own bot token, loaded from a local `.env` file.
- Each run consumes the owner's normal Codex subscription usage and remains subject to its account limits.
- The bridge runs on the owner's machine; do not export or copy Codex login credentials to a hosted server.

### Local configuration

Keep sensitive configuration in a local `.env` file and commit a value-free `.env.sample` that documents the required shape. Add `.env` to `.gitignore`; never place it in SQLite, logs, or Discord messages.

```dotenv
# .env.sample
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_OWNER_USER_ID=
DISCORD_STATUS_CHANNEL_ID=
CHAT_PROVIDER=discord
AGENT_PROVIDER=codex
CLAUDE_MODEL=
MEMORY_REVIEW_TIME=06:00
MEMORY_REVIEW_MAX_CHARS=20000
```

`DISCORD_GUILD_ID` is the fixed V1 server boundary. `DISCORD_STATUS_CHANNEL_ID` selects a status-only online-report channel; it does not restrict conversation starts to that channel. Phase 5 renames the current `DISCORD_ALLOWED_CHANNEL_ID` setting to `DISCORD_STATUS_CHANNEL_ID` with no legacy alias, so existing local `.env` files must update that key when the implementation lands. `DISCORD_OWNER_USER_ID` seeds the first active `owner` record in SQLite's `users` allowlist. `CHAT_PROVIDER` accepts only `discord`. `AGENT_PROVIDER` accepts `codex` and, from Phase 5a, `claude`; an optional `CLAUDE_MODEL` selects a Claude model and is blank by default. No `.env` key may change a runtime's permission, sandbox, or approval policy. The Codex adapter uses the CLI's configured skills, MCP servers, permission policy, and sandbox policy; inoai does not override them. `MEMORY_REVIEW_TIME` is a local host time in `HH:MM` format; `MEMORY_REVIEW_MAX_CHARS` is the maximum archived text sent in one review call, initially `20000`. SQLite always lives at the selected runtime home's `inoai.sqlite`; the deployment folder is the Agent Runtime's project path. The bridge should fail at startup with a clear message if any required value is absent or unsupported.

## Minimal architecture

Use Codex app-server as the first bridge integration. It provides structured session and event handling, avoiding terminal/TUI scraping and avoiding one detached `codex exec` invocation per Discord message.

Implement the bridge in TypeScript on Node.js. This keeps the Discord adapter, CLI runtime client, and SQLite logging in one process and one language. Prefer Node's built-in `node:sqlite` for the initial database layer; add a SQLite package only if the supported Node version cannot provide the required API.

Run Codex with the deployment folder as its configured project path. The core reads the selected runtime home's `agent.md` and supplies it as inoai's deployment-specific personality and operating rules on every session; any normal project `AGENTS.md` found by Codex remains an additional project instruction. The bridge controls message routing and persistence; `agent.md` controls inoai's voice and working rules.

### Dynamic CLI runtime

The bridge depends on one small agent-runtime interface:

```text
createSession(projectPath, initialPrompt) -> agentSessionId
runTurn(agentSessionId, prompt) -> streamed events
cancel(agentSessionId) -> void
health() -> runtime status
```

`AGENT_PROVIDER` selects the Codex adapter or, from Phase 5a, the Claude adapter. The runtime selector is a simple TypeScript `switch`, not a plugin registry. Adding OpenCode later means adding one adapter that satisfies this interface and one selection branch; Discord, SQLite, queueing, dashboard, and memory code stay unchanged.

Each `.inoai-connect*` runtime home selects exactly one provider. For example, `.inoai-connect/` may use `AGENT_PROVIDER=codex` and one Discord bot token, while `.inoai-connect-claude/` uses `AGENT_PROVIDER=claude` and another token. They are separate bot instances with separate SQLite archives and agent Memory; this is deliberate rather than per-user Memory isolation.

The selected runtime home's `agent.md` is the runtime instruction file. Each adapter must deliberately define how it receives inoai's personality rather than assuming all CLIs discover the same filename or format.

Each runtime home's `agent.md` is that Agent Instance's canonical, deployment-scoped personality document. The Codex adapter supplies it explicitly; each future agent-runtime adapter reads and supplies the same document during its session setup. The core must not modify `~/.codex/AGENTS.md`, `~/.codex/AGENTS.override.md`, or any other global Codex setting.

### Claude runtime (Phase 5a)

The Claude adapter spawns the owner's installed `claude -p --output-format stream-json` once per Turn in the project path and resumes the stored Agent Session by ID ([ADR 0008](adr/0008-drive-claude-through-headless-cli.md)). It does not embed the Claude Agent SDK. It supplies `agent.md` with `--append-system-prompt` on every Turn, with the system-prompt snapshot disabled so edits reach existing Sessions, and Claude's default system prompt is kept; project guidance comes from Claude's own `CLAUDE.md` loading, and inoai does not inject `AGENTS.md`. The owner's Claude settings, MCP servers, skills, permission rules, and permission mode apply unchanged.

- Authenticate Claude interactively with the owner's Claude subscription (`claude` then `/login`) before starting the bridge.
- At startup inoai asks the CLI which credential it will use and refuses to start unless it will use the interactive subscription login (`/login`); an API key, auth token, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`, cloud provider, or Anthropic profile causes refusal. It never edits the owner's shell, settings, or credentials.
- Anthropic's Agent SDK documentation states that third-party developers may not offer claude.ai login for their products without approval. inoai offers no login: each owner runs it on their own machine with their own locally signed-in CLI.
- Claude permission prompts fail closed exactly like Codex approval requests ([ADR 0007](adr/0007-claude-matches-codex-fail-closed-approvals.md)).
- A Session bound to a different provider than the runtime home's current `AGENT_PROVIDER` is not resumed; the owner uses `/inoai reset` or a new thread.

### Dynamic chat transport

The application also depends on one small chat-transport interface:

```text
start(onIncomingMessage) -> void
createConversation(parentConversation, initialMessage) -> conversationId
sendMessage(conversationId, text, replyTo?) -> externalMessageId
publishHealth(targetConversation, text) -> externalMessageId
health() -> transport status
```

`CHAT_PROVIDER=discord` selects the only implemented adapter in v1. Adding Slack or Telegram later means adding one adapter and one selection branch. The worker receives provider-neutral inbound messages and sends provider-neutral replies; it does not know Discord's gateway, Slack threads, or Telegram updates.

Discord's initial behavior remains unchanged: a top-level `@inoai` message creates a Discord thread. Each future transport adapter defines its equivalent conversation rule (for example, a Slack thread or Telegram reply chain) behind this interface.

Multiple Agent Instances may share the configured Discord channel. Each instance has a distinct bot identity and reacts only to its own explicit `@label` mention. It binds and processes only threads it created; messages in another bot's thread have no matching Session and are ignored.

A cross-agent mention inside an existing thread is not a handoff and never creates a second Session in that thread. For example, a human `@inoplanner` message inside an inoai-owned thread is processed only as the next inoai turn; inoplanner ignores the thread. Every bot ignores bot-authored Messages, including messages from other Agent Instances, so agent replies cannot trigger one another or create an endless discussion. Start another agent with a new top-level mention; explicit handoff is deferred to a later phase.

A new top-level request must mention exactly one configured agent bot. If it mentions multiple agent bots, every bot rejects it without creating a Session or thread. V1 does not coordinate a reply, select a winner, or split the request; send separate top-level messages instead.

| Component | Responsibility |
| --- | --- |
| Chat transport adapter | Receives eligible messages; creates conversations; posts updates and answers. Discord is the v1 adapter. |
| Bridge | Validates transport identity, serializes work, maps transport conversations to agent sessions, and translates events to transport messages. |
| Codex app-server | Owns the authenticated Codex session, project context, tool permissions, streaming events, and cancellation. |
| SQLite database | Persists transport-conversation-to-agent-session mappings, message/audit logs, and the configured project identity. |

Use SQLite from the first cut. It is a local, zero-service dependency and makes messages and state recoverable after a bridge restart. A separate Electron UI reads it directly. Worker pools and multi-project routing are deferred until there is a demonstrated need.

### Initial local data

Keep the schema intentionally small:

| Table | Minimum contents |
| --- | --- |
| `sessions` | Transport/workspace/conversation IDs, initiating message ID, agent session ID, configured project ID, timestamps, and current state. |
| `users` | Transport-scoped User allowlist, including owner/family role, state, and full audit fields. |
| `messages` | Session ID, external message ID, direction (`user` or `agent`), body, delivery state, and full audit fields. |
| `events` | Session ID, event type, non-secret diagnostic detail, and full audit fields. |
| `memories` | Shared persisted Memory with provenance, soft-delete state, and full audit fields. |
| `memory_reviews` | Timestamped recap entry, source message range since the prior recap, job state, Memory actions, and full audit fields. |

The proposed DDL, indexes, queue-claim rules, and deliberately deferred tables are in [SQLite schema](sqlite-schema.md).

Add queue fields to inbound `messages`: `reply_to_external_message_id`, `state` (`pending`, `processing`, `completed`, or `failed`), and `started_at`/`completed_at`; `created_at` is the receive time. The transport/workspace/message identity is unique, so a duplicate provider event cannot create a second agent turn.

Store the full user and agent messages indefinitely as the local archive used for transcript recovery, diagnostics, and future reference. Do not store credentials, environment values, or raw tool output. Archiving a message does not make it persisted Memory.

### Persisted inoai memory

`memories` is inoai's shared, agent-wide durable memory layer. It is separate from `messages`: conversation logs are historical evidence; memory is a small set of reusable, reviewed facts such as user preferences, project decisions, or stable project context.

Each memory has a text value, a source message ID, timestamps, and state (`active` or `deleted`). On each task, the bridge ranks active shared Memory locally against the current turn and prepends the most relevant results as clearly labeled context, stopping at a fixed 6,000-character budget. It must never inject raw message history as durable memory and must not store credentials or secrets.

The daily Recap can promote information into shared Memory only through a Memory Signal:

- The user explicitly asks inoai to remember, take note of, or treat something as important; or
- The daily review identifies a useful pattern repeated across Recaps.

A one-off fact, ordinary recap item, model-generated claim, secret, speculative statement, or quoted instruction is not a Memory Signal.

Important information can also bypass the daily Recap as a Manual Memory Entry. The local management CLI and separate local UI can create or soft-delete these entries directly; they are stored with `origin = manual` and a timestamp. Chat messages do not directly create Memory in V1.

### Memory review loop

inoai also distills useful memory from everyday conversation automatically. This is a separate, low-priority queue job:

1. Once per day at `MEMORY_REVIEW_TIME` in the host's local time zone, enqueue a `memory review` job for each Conversation with messages since its last successful recap.
2. The normal message worker always runs first. A review runs only when no user message is pending or processing.
3. The review processes the new message range in chronological `MEMORY_REVIEW_MAX_CHARS` windows and creates bounded internal notes. A final aggregation with those notes, active Memory, and relevant prior Recaps outputs one concise recap plus `add`, `update`, `delete`, or `ignore` actions. New Memory requires an explicit Memory Signal or a useful recurring pattern across Recaps.
4. The bridge validates that output and applies it transactionally to SQLite, preserving the source message IDs, recap text, and completion timestamp.
5. It advances the review cursor only after the transaction completes. A failed review remains retryable and does not block conversation.

The review may promote only durable, user-confirmed preferences, confirmed project decisions, and stable facts that meet the Memory Signal rule. It must ignore secrets, credentials, transient tasks, speculation, model-generated claims that the user did not confirm, and instruction-like content quoted from conversation. Each active memory remains editable through the explicit memory controls above.

The daily review is a local timer, not chat-transport polling. If normal work is active at the scheduled time, the due review waits until it is safe to run. A Conversation without new archived messages receives no review. Oversized history is reviewed in chronological windows; the recap cursor advances only after the full range succeeds, so no archive content is silently skipped.

Daily recaps are silent: they write their timestamped recap and outcome to SQLite for later inspection in the separate local UI and never post routine updates to the chat transport. A failed review retries up to three times later that day with bounded backoff, then remains recorded locally until the next daily cycle. It never interrupts a conversation.

## Discord interaction model

| Discord action | Result |
| --- | --- |
| Owner's top-level `@inoai <task>` in an accessible non-report channel of the configured server | Create a Discord thread and bind a fresh Codex session to it. |
| Allowlisted user message in a bound thread | Send it as the next turn without requiring `@inoai`. |
| `/inoai status` in a bound thread | Show project, session state, and whether a turn is running. |
| `/inoai cancel` in a bound thread | Cancel the active turn for that thread. |
| `/inoai reset` in a bound thread | Cancel the active turn, fail queued Messages without running them, and discard that thread's Agent Session binding. The next Message starts a fresh Agent Session. |

These are native Discord guild-scoped slash commands, not text prefixed to a bot mention. The existing bot token registers them; no second API key is required. Only the active owner may invoke them in a bound thread, and control interactions are not Codex turns.

### Future scheduled tasks (deferred)

Scheduled multi-iteration Tasks are intentionally deferred. The provider-neutral Conversation and Agent Session model remains suitable for that phase, but v1 does not contain task tables, task-state prompts, or a scheduler. When introduced, a Task will use a dedicated Conversation and bounded iterations; recurrence remains out of scope until one-off tasks are proven.

The bot ignores messages from bots, ignores unmentioned top-level channel messages, and never treats its own output as input. Inside a bound thread, every allowlisted user's ordinary message is input to inoai. It should acknowledge a task immediately, periodically show a compact working indicator, and split only the completed final response to respect Discord's message limit. Do not post live partial assistant text, tool traces, or raw command output.

Every eligible inbound message, Codex response, and conversation event is written to SQLite before or alongside its Discord delivery. The bot's `inoai is online` health-check message is an event, not part of a Codex conversation.

Persist each final response chunk before attempting Discord delivery. If a send is known to fail, record the delivery failure. If Discord may have accepted a chunk but inoai stopped before saving its Discord message ID, record delivery as uncertain and never resend that chunk automatically on restart. The archived response remains available locally; avoiding duplicate Discord output takes priority over guaranteed delivery.

### Concurrent messages and ordering

Discord can deliver a second task while Codex is answering the first. Do not run both turns against the same Codex session concurrently.

1. On every eligible message event, insert the inbound message as `pending` in SQLite and acknowledge it as queued if another task is running.
2. A Session worker selects its oldest pending message, marks it `processing`, and sends it to Codex only when that Session has no other active turn.
3. It persists Codex's completed answer, delivers it to Discord, marks the inbound message `completed`, then starts the next pending message.
4. Before an Agent Runtime turn can start, a stale `processing` row may return to `pending` after restart. Once execution may have begun, a stale row without proof of no side effects has an uncertain outcome: record it as failed, notify the owner once, and require a fresh request rather than automatically replaying it. The Phase 2 queue initially requeues stale rows because no runtime execution is connected yet; Phase 5 must add this safety distinction when it wires in the runtime.

Reset preserves archived Messages and Events. It never replays cancelled or queued work into the new Agent Session; if the active turn's outcome is uncertain, report that uncertainty rather than claiming its side effects were undone.

For V1, serialize turns within a Conversation and let different Conversations run independently only after an authenticated, read-only two-session probe of the selected Codex app-server flow passes in an isolated temporary project. The probe uses the owner's existing local Codex sign-in and does not require a Discord bot token. Until it passes, or if concurrency later becomes unreliable, use one global queue without dropping queued Messages. This prevents context races and preserves service at reduced throughput.

When a user replies to an older Discord message after newer work is queued, treat that reply as the next turn when it reaches the worker. Store its Discord reply reference and include a compact quoted reference to the replied-to message in the Codex prompt. This preserves the user's intended target without attempting to rewind an already-advanced Codex session.

## Safety model

Discord messages are untrusted input, even in a personal server. The first release should enforce these controls:

- Per Agent Instance: one Discord server, one deployment-folder project path, and a SQLite-backed User allowlist.
- Only an active allowlisted User's top-level `@inoai` mention or message in a bound thread reaches the Agent Runtime.
- Persist and serialize incoming turns; never interleave concurrent requests against a Codex session.
- Launch the Agent Runtime with the configured local Codex CLI capabilities. A chat message cannot weaken, bypass, or elevate Codex's configured approval and sandbox policies.
- Do not expose generic shell execution, environment variables, auth files, or arbitrary repository selection as bot features.
- Write messages and non-secret metadata (time, Discord user ID, thread ID, session ID, outcome) to the local SQLite database; never write credentials, environment values, or raw tool output.

## Deliberate MVP decisions

1. **Owner-only in V1, User-ready for later.** Startup seeds the configured owner's Discord ID as the first active User. Family access is disabled until active User records are added. inoai Memory remains shared agent Memory, with source-message provenance rather than per-User isolation.
2. **One project path per Agent Instance.** A project selector inside one runtime home increases the consequences of a compromised Discord account without solving an MVP need.
3. **Thread equals session.** This is intuitive in Discord and keeps conversational context isolated.
4. **Explicit reset.** A new session must be requested; a long thread never silently loses its Codex context.
   Agent Sessions do not expire automatically; `/inoai reset` is the only V1 way to replace a thread's live session.
5. **Configured Codex permissions, no task automation in v1.** inoai exposes the skills and tools already available to its local Codex CLI environment, but has no bot-specific "approve everything" command, scheduler, or autonomous loop.

## Non-goals

- OpenAI API integration, API-key management, usage resale, or per-user billing.
- Public Discord access, teams, roles, or quota sharing.
- Cloud hosting of the Codex credential or project workspace.
- Agent-run file edits, commits, mutation-capable commands, scheduled or unbounded autonomous task loops, pull-request automation, or CI integration.
- File attachment, image, voice, or browser-control support.
- A separate hosted web application, database migration system, or observability stack.

## Implementation plan

See [implementation phases](implementation-phases.md) for the ordered delivery plan, with smaller tasks, testable outcomes, and test scenarios for every phase. See [initial repository structure](repository-structure.md) for the implementation layout and module seams.
See [plan review](plan-review.md), [domain language](../CONTEXT.md), and [ADR 0001](adr/0001-narrow-provider-adapters.md) for the refined decisions.

## Separate Electron analytics UI

The analytics UI is a separate Electron application with a Tailwind renderer, not a server embedded in the core executable. Its Electron main process opens an explicitly selected `.inoai-connect/inoai.sqlite`; it has a narrow local-only ability to create or archive Manual Memory Entries.

The distributed `inoai-ui` Electron bundle sits beside the core executable, not inside `.inoai-connect/`. The core's `inoai ui` command launches that sibling bundle against the current deployment's runtime home.

- Bind only to `127.0.0.1` by default; conversation logs and memories must not be exposed on the network.
- Keep the Electron UI on the same host in v1. Remote access, tunneling, and UI authentication are explicitly out of scope.
- Show current Discord/Codex connection state, queued work, recent sessions, per-session message timelines, timestamped recaps, memory-review outcomes, and active memories.
- The core exposes no dashboard routes or dashboard port. The Electron main process owns SQLite access; the renderer receives only narrow data/actions through a preload bridge.
- Keep all UI data read-only except Manual Memory Entry creation and soft deletion. These controls never invoke the Agent Runtime.
- Do not place secret values, raw environment variables, or raw Codex tool output in UI data.
- Retrying work and UI authentication are deferred. Add them only when the local-only view proves insufficient.

The UI is started independently and is never announced to Discord. It opens the explicitly selected local SQLite file directly; it does not require a core HTTP API and must not expose the database remotely. Disable renderer Node integration and expose only the required SQLite operations through a narrow preload bridge.

The UI includes a **Load SQLite** action. It opens a native file picker for `inoai.sqlite`, validates the expected schema and that the file belongs to a `.inoai-connect*` runtime home, then switches its active Agent Instance view. It reads only SQLite, never the selected home's `.env`; recent selections may be kept in Electron's own application data.

## Discord approval controls

In V1, every Codex approval request is declined through the live app-server protocol. inoai records only a non-secret outcome and posts a fixed safe notice in the active thread: the action needs local Codex. It never posts **Approve**/**Reject** buttons, stores raw request details, auto-approves, or changes Codex's configured sandbox/approval policy. Codex CLI `0.157.1` exposes arbitrary request text and best-effort action fields, not a complete safe preview for informed Discord consent. Do not replace this gap with a wrapper-level command allowlist or a coarse blind-approval prompt. Revisit buttons only after a supported safe-preview mechanism passes consent and secret-leak tests.

No new approval stays pending in SQLite. If an earlier local build left a pending approval row or Discord controls, recovery fails that row and makes the controls inert; a saved row cannot restore a live runtime request. Never replay an interrupted turn from SQLite alone.

## Acceptance checks

Phase 5 includes deterministic fake-transport/runtime tests, an isolated authenticated read-only Codex concurrency probe, and a focused live Discord smoke test in a private test channel against a disposable project. The bot token stays in the ignored local runtime-home `.env`, never in chat or committed files. Phase 8 retains fresh-deployment and failure/recovery end-to-end acceptance.

- With no OpenAI API key configured, an allowlisted user can create a thread session and get a Codex response through Discord.
- A second message in that thread is treated as a continuation, not an unrelated task.
- A message from an unallowlisted user cannot invoke Codex.
- `/inoai cancel` stops an in-flight task without affecting another thread.
- Restarting the bridge preserves or clearly reports the state of existing mappings.
- A task that requires a Codex permission approval follows the host's configured policy and is never silently elevated by Discord.

## Open decisions before implementation

No open product decisions remain for V1. Future family access, remote UI access, shared Memory between Agent Instances, and scheduled Tasks require separate phases.

## References

- [Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli?translationFallback=es-419): ChatGPT sign-in, `codex exec`, `codex resume`, permissions, and CLI workflow support.
- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server): structured client integration and authentication/session operations.
- [Codex pricing and usage documentation](https://learn.chatgpt.com/docs/pricing): subscription usage and API-key distinction.
