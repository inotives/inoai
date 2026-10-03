<p align="center">
  <img src="logo.svg" alt="inoai logo" width="160">
</p>

<h1 align="center">inoai</h1>

<p align="center">
  A local Discord bridge to your own signed-in coding-agent CLI: Codex, Claude Code, or OpenCode.
</p>

<p align="center">
  <img alt="Status: V1 in progress" src="https://img.shields.io/badge/status-V1%20in%20progress-white?style=for-the-badge&labelColor=000000">
  <img alt="Runtime: Node.js 22" src="https://img.shields.io/badge/runtime-node.js%2022-white?style=for-the-badge&labelColor=000000">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-typescript-white?style=for-the-badge&labelColor=000000">
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-white?style=for-the-badge&labelColor=000000">
</p>

<p align="center">
  <a href="docs/discord-codex-cli-harness-proposal.md">Proposal</a>
  ·
  <a href="docs/implementation-phases.md">Implementation Phases</a>
  ·
  <a href="docs/sqlite-schema.md">SQLite Schema</a>
  ·
  <a href="docs/adr/">ADRs</a>
  ·
  <a href="CONTEXT.md">Domain Language</a>
</p>

---

## What It Is

inoai is a local personal-agent bridge. It connects a Discord bot to a coding-agent CLI that is already installed and signed in on your machine, and it keeps conversation history and durable agent Memory in a local SQLite file.

It drives the CLI you already use instead of calling a model API. Codex runs on your ChatGPT sign-in, Claude Code on your Claude subscription, and OpenCode on whatever provider it is configured with. inoai itself never calls the OpenAI or Anthropic API, and it never loosens the CLI's own permission policy.

- An `@inoai` mention starts a dedicated Discord thread, and follow-ups in that thread continue the same Agent Session.
- SQLite records users, sessions, messages, events, approvals, daily Recaps, and shared Memory, with audit fields and soft deletion.
- Permission requests fail closed with a fixed notice. Discord **Approve** / **Reject** buttons are deferred.
- A silent Daily Memory Review turns each Agent Session's new Messages into a Recap and, when warranted, shared Memory.
- A separate macOS Electron app (Phase 7) will provide analytics and Manual Memory management by opening SQLite directly.

Status: Phases 1–6 (including 5a and 5b) are implemented: scaffolding, the SQLite archive and queue, the Discord transport, the Codex runtime, the end-to-end conversation worker, Claude CLI and OpenCode as further runtimes, and the Daily Memory Review (Claude homes only in V1). Phase 6c has the local metadata, configuration, schema, exporter, ADC-backed production client, scheduler lifecycle wiring, and offline acceptance boundary. The Electron app and V1 hardening remain.

## Core Model

Deploy inoai into the folder it should assist. Each `.inoai-connect*` directory is one independent Agent Instance with its own configuration, Discord identity, Agent Sessions, SQLite archive, and Memory. Set optional `AGENT_NAME` to give it a human-readable analytics label; when blank, the runtime-home folder name is used:

```text
my-project/
├── inoai                      # portable core executable
├── inoai-ui.app/              # sibling Electron analytics app
├── .inoai-connect/            # general Codex agent (default runtime home)
│   ├── .env
│   ├── agent.md
│   ├── inoai.sqlite
│   └── backups/
├── .inoai-connect-planner/    # a role-specific instance
├── .inoai-connect-claude/     # Claude CLI adapter (Phase 5a)
└── .inoai-connect-opencode/   # OpenCode CLI adapter (Phase 5b)
```

On first start, the core creates the runtime home from bundled templates and never overwrites an existing one. Only one core process may use a runtime home at a time; different homes run independently. Runtime homes are git-ignored and must never be committed.

`agent.md` defines that instance's role and personality. Project guidance comes from each CLI's own loading: `AGENTS.md` for Codex and OpenCode, `CLAUDE.md` for Claude.

Discord rules:

- Multiple agent bots may share a channel. Each reacts only to its own top-level `@label` mention and owns only the threads it created.
- A mention of another bot inside an existing thread is not a handoff; start that agent from a new top-level message instead. A top-level message mentioning several agent bots creates nothing.
- Bots ignore bot-authored messages, which prevents agent-to-agent loops.
- V1 admits only the configured owner. Family access is a later phase.
- An owner mention starts a conversation in any accessible channel of the configured server except the status-only channel. Ordinary top-level messages do nothing; follow-ups in a bound thread need no mention.

## Dependencies

```text
Node.js 22 or newer
macOS (V1 release target)
A Discord bot per concurrently running Agent Instance
One signed-in agent CLI per runtime home: codex, claude, or opencode
```

## Installation

```bash
npm install
npm run build
```

## Setup

### Codex (default runtime home)

```bash
# The first validation creates .inoai-connect/ with a blank .env and reports missing settings.
npm run validate
cp .env.sample .inoai-connect/.env
# Edit .inoai-connect/.env with your local Discord values.
npm run validate
npm start
```

### Optional macOS launchd supervisor

Manual startup remains supported. For unattended operation on macOS, install an
optional per-runtime `launchd` user agent. It restarts the core after a process
crash or machine restart; the runtime home's lock still prevents two cores from
using the same SQLite archive. Do not install a supervisor for a runtime home
while also running that home manually.

From the repository root, replace the six placeholders in the template with
absolute paths and the selected direct-child runtime-home name. The template
contains no environment variables or credentials:

```bash
INOAI_ROOT="$PWD"
CONNECT_DIR="$INOAI_ROOT/.inoai-connect-planner"
LABEL="com.inotives.inoai.planner"
NODE_BIN="$(command -v node)"
LOG_DIR="$HOME/Library/Logs/inoai"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__INOAI_ROOT__|$INOAI_ROOT|g" \
    -e "s|__CONNECT_DIR__|$CONNECT_DIR|g" \
    -e "s|__STDOUT_LOG__|$LOG_DIR/$LABEL.out.log|g" \
    -e "s|__STDERR_LOG__|$LOG_DIR/$LABEL.err.log|g" \
    launchd/com.inotives.inoai.plist.template > "$PLIST"
plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
```

Use one distinct `LABEL` and runtime home per concurrently running Agent
Instance. Verify the generated plist contains only executable, project, runtime
home, and log paths; never add `DISCORD_BOT_TOKEN` or any other `.env` value.
The app reads the ignored runtime home's `.env` itself.

Stop and remove the supervisor before starting the same home manually:

```bash
launchctl bootout "gui/$(id -u)/$LABEL"
rm "$PLIST"
```

`bootout` stops the managed process and disables KeepAlive. The log files are
ordinary local diagnostics and may be removed separately after checking them.
If `launchctl bootstrap` reports that the label is already loaded, boot it out
first; do not start a second copy against the same runtime home.
Live `launchctl` KeepAlive behavior was not exercised in this non-GUI
environment; validate the generated plist on the target macOS machine.

Set `DISCORD_STATUS_CHANNEL_ID` to the channel for the startup online notice; it never starts conversations. The older `DISCORD_ALLOWED_CHANNEL_ID` key is no longer accepted; update existing local runtime-home `.env` files before starting this version. The bot needs access to the status channel and to every channel where you start conversations, including permission to create threads.

`npm run validate` is offline. It checks the required settings, `CHAT_PROVIDER=discord`, `AGENT_PROVIDER` (`codex`, `claude`, or `opencode`), a well-formed optional `CLAUDE_MODEL`, a local `HH:MM` `MEMORY_REVIEW_TIME`, and a positive `MEMORY_REVIEW_MAX_CHARS`. It does not contact Discord or any agent CLI.

### Optional BigQuery analytics

BigQuery sync is optional and never required for normal Discord or Memory Review operation. The Phase 6c implementation bundles the Google BigQuery client, creates an ADC-backed client when configuration is present, and starts/stops the asynchronous scheduler with the core. Setting these values enables uploads; leaving them blank keeps analytics disabled.

Create a BigQuery project and dataset, then set these non-secret values in the runtime home's `.env`:

```dotenv
BIGQUERY_PROJECT_ID=your-gcp-project-id
BIGQUERY_DATASET_ID=inoai_analytics
BIGQUERY_SYNC_INTERVAL_MINUTES=60
```

inoai is designed to use Google Application Default Credentials (ADC); it does not accept or store service-account private keys. Set up ADC for a cloned checkout:

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install); this provides both `gcloud` and `bq`.
2. Sign in for local ADC: `gcloud auth application-default login`.
3. Select the project used for BigQuery: `gcloud config set project YOUR_GCP_PROJECT_ID`.
4. If Google asks for a quota project, set it explicitly: `gcloud auth application-default set-quota-project YOUR_GCP_PROJECT_ID`.
5. In Google Cloud IAM, grant the ADC account the minimum BigQuery permissions needed by your deployment (typically BigQuery Job User on the project and BigQuery Data Editor on the dataset).
6. Verify ADC without printing the credential: `gcloud auth application-default print-access-token >/dev/null`.
7. To create the dataset with `bq`, authenticate the CLI separately with `gcloud auth login`, then run `bq --location=asia-southeast1 mk --dataset YOUR_GCP_PROJECT_ID:inoai_analytics`.
8. Verify the dataset with `bq ls --project_id=YOUR_GCP_PROJECT_ID inoai_analytics`.
9. Run `npm run validate -- --connect-dir .inoai-connect` to check the local configuration.

Leave the three settings blank to keep sync disabled. A malformed optional setting disables only the analytics path and is reported without printing its value. ADC files remain managed by the Google Cloud CLI; inoai never copies them into the runtime home, SQLite, logs, or Discord. The exporter is asynchronous and non-blocking; local chat operation does not depend on BigQuery availability. A missing ADC account or unavailable cloud is a sync failure/defer condition, not a core startup failure.

Each runtime home has one local `agent_instance_metadata` row containing a stable generated `agent_instance_id` and a non-unique `agent_name` (default: the runtime-home folder name). Two homes can therefore share one BigQuery dataset without colliding:

```text
.inoai-connect-planner/inoai.sqlite  ->  550e... | planner
.inoai-connect-claude/inoai.sqlite   ->  7b21... | claude-reviewer
```

The analytics schema has six tables: `agent_instances`, `sessions`, `messages`, `memory_reviews`, `memories`, and `events`. Every row carries `agent_instance_id`, `agent_name`, `source_id`, `source_created_at`, `source_updated_at`, optional `source_deleted_at`, and audit fields. Rows are partitioned by `source_updated_at`, clustered by `agent_instance_id`, and upserted by `(agent_instance_id, source_id)`. Message, Memory, Recap, failure, and Event text uses the existing secret redaction rules; credentials, environment values, approval details, and raw tool input/output are not exported. Soft deletes remain as tombstones.

Sync uses a local per-table watermark with a one-second overlap, so equal timestamps and retries are safe. The default interval is 60 minutes when BigQuery is configured; `BIGQUERY_SYNC_INTERVAL_MINUTES` changes it. Failed uploads record non-secret local events and bounded retry state without delaying Turns or Memory Reviews. Configure BigQuery table or dataset expiration and review partition usage for retention and cost control; BigQuery is an analytics sink, not a replacement for local SQLite.

The production client uses Google Application Default Credentials and the scheduler performs an initial sync after core startup, then repeats at the configured interval. The offline test suite uses a fake sink; live cloud uploads require the local ADC, IAM, project, and dataset setup above.

Codex runtime recovery is automatic: after a timeout or app-server exit, inoai marks that Turn uncertain without replaying it, reconnects with bounded backoff, and resumes later queued Turns from their persisted Agent Sessions. If the whole process crashes, the optional launchd supervisor above can restart it. A runtime-home lock prevents manual startup and launchd from running two cores against the same SQLite archive.

Any named runtime home works the same way with `--connect-dir` (a packaged deployment runs `inoai --connect-dir <home>` and `inoai ui --connect-dir <home>`):

```bash
npm run validate -- --connect-dir .inoai-connect-planner
cp .env.sample .inoai-connect-planner/.env
npm run validate -- --connect-dir .inoai-connect-planner
npm start -- --connect-dir .inoai-connect-planner
```

Give each concurrently running Agent Instance its own Discord bot and token. Reusing one token across runtime homes is only safe when just one of them runs at a time.

### Claude

inoai runs the owner's installed `claude -p` headlessly for each Turn ([ADR 0008](docs/adr/0008-drive-claude-through-headless-cli.md)). Install Claude Code and sign in with your Claude subscription (`claude`, then `/login`), then:

```bash
npm run validate -- --connect-dir .inoai-connect-claude
cp .env.sample .inoai-connect-claude/.env
# Edit .inoai-connect-claude/.env: set AGENT_PROVIDER=claude and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-claude
npm start -- --connect-dir .inoai-connect-claude
```

`CLAUDE_MODEL` is optional. Leave it blank for the CLI default, or set a model name or alias such as `sonnet`. It must start with a letter or digit and contain only letters, digits, and `. _ : - [ ]`. Other runtimes ignore it.

**Credential guard.** inoai accepts only the interactive Claude subscription login. At `npm start` it asks the CLI which credential it will use (`claude auth status`) and refuses to start, naming the source, if any of these would take over:

- an API key, such as `ANTHROPIC_API_KEY` or a Console key;
- an auth token or Anthropic profile, such as `ANTHROPIC_AUTH_TOKEN` or a token in Claude settings;
- `CLAUDE_CODE_OAUTH_TOKEN` in the environment;
- an `apiKeyHelper`;
- a cloud provider or gateway.

Each Turn checks again, and a non-subscription credential fails the Turn with a notice to run `claude /login`. inoai never reads credential files or edits your shell, settings, or credentials. To fix a refusal, unset the variable or remove the setting, run `claude /login` if needed, and restart.

**Subscription login policy.** Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview) says that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products. inoai offers no login: each owner runs it on their own machine against their own locally signed-in CLI, and inoai never handles a Claude credential.

### OpenCode

inoai runs the owner's installed `opencode run --format json --standalone` for each Turn and uses whatever provider and model OpenCode is configured with ([ADR 0009](docs/adr/0009-opencode-uses-its-configured-provider.md)). `opencode` must be on the PATH of the shell that runs `npm start`; the default installer puts it in `~/.opencode/bin`, which a non-interactive shell may not include.

```bash
npm run validate -- --connect-dir .inoai-connect-opencode
cp .env.sample .inoai-connect-opencode/.env
# Edit .inoai-connect-opencode/.env: set AGENT_PROVIDER=opencode and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-opencode
npm start -- --connect-dir .inoai-connect-opencode
```

At `npm start`, inoai runs `opencode --version` and refuses to start with `OpenCode CLI is unavailable` if it cannot run.

- Each Turn is a standalone `opencode run` in the deployment folder. The first Turn creates the OpenCode session and later Turns resume it with `--session`; these sessions appear in OpenCode's own session list for the deployment folder.
- OpenCode (2.0.22) ignores the `instructions` config setting, so `agent.md` is sent as a delimited block at the start of every Turn's prompt.
- inoai never edits OpenCode configuration.

**Data and billing.** inoai passes no model or provider and adds no credential guard.

- With the free OpenCode Zen default, nobody is billed, but Discord prompts and project context are sent to opencode.ai.
- A provider or API key you later configure in OpenCode is used and billed as configured.
- The free tier allows use only "from within OpenCode". inoai works today because it runs the stock CLI; a future OpenCode change could refuse these runs, which shows up as the OpenCode authentication notice.

**Permissive defaults.** OpenCode's built-in rules allow shell commands and file edits, and only a few actions ask (such as file tools outside the project or reading `.env` files). With default settings a Discord message can make OpenCode run commands and change files in the deployment folder; only the asking cases are rejected. inoai keeps your configured policy and never passes `--auto`, `--yolo`, or `--dangerously-skip-permissions`. For Codex-like behavior, set shell and edit to `ask` in your own OpenCode configuration.

## Common Commands

| Command | Purpose |
|---|---|
| `npm run validate` | Create the runtime home if needed and validate its `.env` offline. |
| `npm start` | Start the core for the default runtime home. |
| `npm start -- --connect-dir <home>` | Start a named runtime home. `npm run validate`, `ui`, and `memory` accept the same option. |
| `npm start -- memory add "<text>"` | Add a Manual Memory Entry without starting an Agent Runtime. |
| `npm start -- memory list` | List active Memory with `origin` (`manual` or `review`); review-made entries also show `review_id` and `source_message_id`. |
| `npm start -- memory delete <id>` | Soft-delete a Memory entry of either origin. |
| `npm start -- ui` | Launch the sibling Electron UI with the selected `inoai.sqlite` path only. |
| `npm test` | Build and run the test suite. |
| `npm run typecheck` | Type-check without emitting. |
| `/inoai status` | Show the thread's session, queue, and failure counts. |
| `/inoai cancel` | Stop the active Turn. |
| `/inoai reset` | End the session, cancel queued work, keep the archive, and start a fresh session with the next message. |

The `/inoai` slash commands are owner-only, work in a thread the bot owns, and reply privately.

## Runtime Behavior

All three runtimes share the same queue, archive, and safety rules:

- Turns run FIFO per Agent Session. When a runtime proves cross-session concurrency at startup (Codex and Claude probes), different threads run in parallel; otherwise, and always for OpenCode, all Turns share one global FIFO queue.
- Only Turns proven never to have started are retried (at most three attempts in total). An uncertain outcome is recorded and you are asked for a fresh request ([ADR 0002](docs/adr/0002-retry-only-proven-safe-runtime-turns.md)).
- Permission requests fail closed with a fixed notice to use the local CLI for the blocked action ([ADR 0003](docs/adr/0003-fail-closed-on-unsafe-approval-previews.md), [ADR 0007](docs/adr/0007-claude-matches-codex-fail-closed-approvals.md)). inoai never stores the requested action; Claude and OpenCode record only a denial count.
- Each CLI's own settings, MCP servers, skills, sandbox, and permission rules apply unchanged to Turns; Memory Reviews run without them. For Claude, the CLI denies any action your settings do not already allow.
- At startup, Codex and Claude run a concurrency probe; the Claude probe makes two short, tool-free `haiku` calls that count against your subscription usage. Startup logs which mode is active.
- Sign-in and usage failures post the runtime's own fixed notice, for example to run `codex login` or `claude /login`.
- `agent.md` is sent with every Turn, so edits apply from the next Turn, including in existing threads.
- A thread bound to a different provider is not resumed; its notice offers `/inoai reset` or a new thread. A session the CLI can no longer find fails closed with a notice to run `/inoai reset`, and is never silently recreated.

## Daily Memory Review

Once a day, inoai reviews each Agent Session's Messages since that Session's last review. A review writes one Recap and may add, update, or delete Memory ([ADR 0010](docs/adr/0010-memory-reviews-run-text-only-in-throwaway-sessions.md)).

What a review keeps:

- A new Memory needs an explicit request in one of your own Messages, such as "remember that…", "please note…", or "keep this in mind", or the same pattern in at least two earlier Recaps.
- Quoted, fenced, or inline-code text and agent replies never count as your request, and secret-like text is always dropped; the model is told to leave out one-off requests. Pasted text without quotes that contains a request like "Remember to…" cannot be told apart from your own request and may still count.
- Deleting a review-made Memory needs evidence: one of your Messages in the reviewed range or at least two earlier Recaps. Replacing one needs the same evidence as a new Memory.
- Reviews never change Manual Memory Entries. inoai checks every action the model proposes and drops the ones that fail.

When it runs:

- After `MEMORY_REVIEW_TIME` (local `HH:MM`, sample `06:00`), at most once per local date, caught up at startup or after the machine wakes.
- Chat comes first. A review starts only when no chat Message is waiting or being answered, and a new chat Message interrupts it without using a retry; after five interruptions in a day it waits for the next day's run.
- A failed review is retried after 1, 2, and 4 hours, then waits for the next day's run.
- `MEMORY_REVIEW_MAX_CHARS` sets how much text the model reads at a time; long ranges are split into chronological parts.

Reviews are silent: they never post to Discord. Until the Phase 7 UI, inspect Memory with `npm start -- memory list`; Recaps (`memory_reviews`) and the non-secret `memory_review_cycle`, `memory_review_completed`, `memory_review_deferred`, and `memory_review_skipped` Events are in `inoai.sqlite`.

Runtime support:

- **Claude** is the only runtime that reviews in V1. Each review is a throwaway, text-only `claude -p` run in a temporary folder with no tools, no MCP servers, no saved session, `--safe-mode`, and a fixed inoai system prompt, so your `CLAUDE.md`, skills, plugins, hooks, and Claude memory are not used. A run that still reports tools, MCP servers, or memory paths fails. Reviews count against your Claude subscription usage.
- **Codex** review code is present but disabled. The 2026-10-03 probe against `codex-cli 0.159.3` saw 11 MCP startup notifications (6 `starting`, 5 `ready`) in the authenticated throwaway app-server session, so it did not prove MCP-free execution. No tool request or disposable-project file change occurred, but a correct-looking answer is insufficient to enable reviews; see [ADR 0011](docs/adr/0011-codex-memory-reviews-need-tool-free-proof.md).
- **OpenCode** reviews are not supported.

Codex and OpenCode homes record a `memory_review_skipped` Event and keep their review cursors, so no Messages are marked reviewed without a review.

A review sends archived Message text, current Memory, and recent Recaps to the runtime's provider (Anthropic, for Claude homes), with secret-like lines replaced by `[redacted: secret-like text]`. inoai stores only the Recap and accepted Memory, never the prompt or the model's raw reply.

## Implementation Phases

```text
1.  Scaffolding
2.  SQLite archive and queue
3.  Discord transport
4.  Codex runtime
5.  End-to-end conversation worker
5a. Claude runtime
5b. OpenCode runtime
6.  Daily Memory Review
6c. BigQuery analytics sync                 (current)
7.  Separate Electron analytics UI
8.  V1 acceptance and operational hardening
```

See [docs/implementation-phases.md](docs/implementation-phases.md). Deferred after V1: Slack and Telegram adapters; family access, remote UI access, and cross-instance Memory sharing; scheduled multi-step Tasks; cross-machine backups and Windows/Linux release packages.

## Development

During development, use the ignored repository-root `.inoai-connect/` as the local runtime home. Tests must use disposable runtime homes in the system temporary directory and never touch real development data.

```bash
npm test
npm run typecheck
npm run build
```

For each phase, follow the workflow in [AGENTS.md](AGENTS.md): grill the phase docs, branch from `main`, split the phase into AgentRig tasks, and drive each task through an independent worker and reviewer before the integrated phase review.

## Repository Layout

```text
inoai/
├── docs/
│   ├── adr/                                  # architecture decisions 0001–0012
│   ├── discord-codex-cli-harness-proposal.md
│   ├── implementation-phases.md
│   ├── sqlite-schema.md
│   ├── plan-review.md
│   ├── repository-structure.md               # initial planned layout
│   └── phase-*-spike.md                      # verified CLI contracts
├── src/
│   ├── index.ts                              # CLI entry, wiring, provider switch, Memory commands
│   ├── config.ts, runtime-home.ts            # .env validation, runtime-home bootstrap and lock
│   ├── transport.ts, inbound-policy.ts       # Discord transport and routing
│   ├── conversation-worker.ts                # per-Session FIFO worker
│   ├── runtime-turn.ts, agent-session.ts     # Turn retries, notices, session binding
│   ├── prompt-context.ts                     # Memory context and secret filter
│   ├── agent-runtime.ts                      # provider-neutral runtime seam
│   ├── codex-runtime.ts, codex-app-server.ts # Codex adapter
│   ├── claude-runtime.ts                     # Claude adapter
│   ├── opencode-runtime.ts                   # OpenCode adapter
│   ├── approval-relay.ts                     # fail-closed permission notices
│   ├── concurrency-probe.ts                  # startup concurrency probes
│   ├── memory-review.ts                      # Daily Memory Review engine
│   ├── memory-review-scheduler.ts            # daily cycle and chat-first scheduling
│   ├── database.ts                           # SQLite schema and state
│   ├── ui.ts                                 # Electron UI launcher
│   └── test/
├── .agent-rig/                               # AgentRig tasks and handoffs
├── AGENTS.md
├── CONTEXT.md
├── README.md
└── logo.svg
```
