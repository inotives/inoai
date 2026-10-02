# inoai

inoai is a local personal-agent bridge: it connects a Discord bot to a locally authenticated coding-agent CLI, beginning with Codex CLI and the owner’s ChatGPT subscription. It stores conversation history and durable agent Memory in SQLite, without using the OpenAI API.

> **Status:** Phases 1–5, 5a, and 5b are implemented: scaffolding, the SQLite archive and queue, the Discord transport, the Codex runtime, and the end-to-end conversation worker. Phase 5a adds Claude CLI and Phase 5b adds OpenCode as further runtimes. Daily Memory Review, the Electron app, and V1 hardening remain later work.

## V1 in brief

- TypeScript core, Discord transport, and Codex CLI runtime, with Claude CLI (Phase 5a) and OpenCode (Phase 5b) as further runtimes.
- Discord `@inoai` starts a dedicated thread; follow-up messages in that thread continue the same Agent Session.
- SQLite persists users, sessions, messages, events, approvals, daily recaps, and shared agent Memory.
- Memory Review configuration is validated locally; scheduled review execution is deferred.
- Codex capability, MCP, sandbox, and approval settings come from the local Codex CLI environment. In V1, every permission request is declined with a fixed safe notice; Discord **Approve** / **Reject** buttons are deferred. Claude and OpenCode follow the same rules with their own local settings.
- A separate macOS Electron app provides analytics and manual Memory management by opening SQLite directly.

## Deployment layout

Deploy inoai into the folder it should assist:

```text
my-project/
├── inoai                 # portable core executable
├── inoai-ui.app/         # sibling Electron analytics app
└── .inoai-connect/       # ignored, per-agent runtime data
    ├── .env
    ├── agent.md
    ├── inoai.sqlite
    └── backups/
```

On first start, the core creates `.inoai-connect/` from bundled templates. It never overwrites an existing runtime home.

`agent.md` defines the role and personality for that deployment. A project-level `AGENTS.md`, if present, remains normal project guidance for Codex and OpenCode; Claude reads the project's `CLAUDE.md` instead.

## Agent Instances

One `.inoai-connect*` directory is one independent Agent Instance. Each has separate configuration, Discord identity, agent sessions, SQLite archive, and Memory.

```text
.inoai-connect/           # general Codex agent
.inoai-connect-planner/   # planner role
.inoai-connect-designer/  # designer role
.inoai-connect-claude/    # Claude CLI adapter (Phase 5a)
.inoai-connect-opencode/  # OpenCode CLI adapter (Phase 5b)
```

Run a named instance with its runtime home:

```text
inoai --connect-dir .inoai-connect-planner
inoai ui --connect-dir .inoai-connect-planner
```

Only one core process may use a runtime home at a time. Different homes may run independently.

## Discord rules

- Multiple agent bots may share a channel. Each reacts only to its own top-level `@label` mention and owns only threads it created.
- A mention of another bot inside an existing thread is not a handoff. Start that agent from a new top-level message instead.
- A top-level message mentioning multiple agent bots is intentionally unsupported in V1; no Session or thread is created.
- Bots ignore bot-authored messages, preventing agent-to-agent loops.
- V1 admits only the configured owner. Family access is a later phase.
- An owner mention can start a conversation in any accessible channel of the configured server except the status-only channel. Ordinary top-level messages do nothing; bound-thread follow-ups need no mention.

## Development

During development, use the ignored repository-root `.inoai-connect/` as the persistent local runtime home. Tests must use disposable runtime homes in the system temporary directory and must not touch real development data.

### Local setup

inoai requires Node.js 22 or newer.

```sh
npm install
npm run build
```

The first validation or start creates the ignored `.inoai-connect/` runtime home with a blank `.env`, `agent.md`, and `inoai.sqlite`. Copy the value-free sample into that home and fill in the Discord values locally; never commit the resulting `.env` or any `.inoai-connect*/` directory.

Set `DISCORD_STATUS_CHANNEL_ID` to the server channel for the startup online notice. The former `DISCORD_ALLOWED_CHANNEL_ID` key is no longer accepted; update existing local runtime-home `.env` files before starting this version. The bot must have access to the status channel and any channel where you want to start conversations, including permission to create threads.

```sh
npm run validate
cp .env.sample .inoai-connect/.env
# Edit .inoai-connect/.env with your local Discord values.
npm run validate
```

`npm run validate` is offline: it checks required settings, `CHAT_PROVIDER=discord`, `AGENT_PROVIDER=codex`, `claude`, or `opencode`, a well-formed optional `CLAUDE_MODEL`, local `HH:MM` review time, and a positive review limit. It does not contact Discord, Codex, Claude, or OpenCode.

Start the local core after validation:

```sh
npm start
```

Use an independent named runtime home with the same commands:

```sh
# This creates a blank .inoai-connect-planner/.env and reports missing settings.
npm run validate -- --connect-dir .inoai-connect-planner
cp .env.sample .inoai-connect-planner/.env
# Edit .inoai-connect-planner/.env with your local Discord values.
npm run validate -- --connect-dir .inoai-connect-planner
npm start -- --connect-dir .inoai-connect-planner
```

Run the focused checks with:

```sh
npm test
```

### Manual Memory

Manual Memory writes SQLite directly and never starts an Agent Runtime:

```sh
npm start -- memory add "Prefer focused tests"
npm start -- memory list
npm start -- memory delete 1
```

### UI launcher

The macOS UI bundle is a sibling deployment artifact, not runtime-home data. From a packaged deployment use `inoai ui`; during development use the equivalent command below. It passes only the selected `inoai.sqlite` path to `inoai-ui.app` and does not read or change `.env`.

```sh
npm start -- ui
npm start -- ui --connect-dir .inoai-connect-planner
```

## Claude runtime

A runtime home can drive the owner's local Claude Code CLI instead of Codex. inoai runs `claude -p` headlessly for each Turn and never uses the Anthropic API ([ADR 0008](docs/adr/0008-drive-claude-through-headless-cli.md)).

### Prerequisites

- Node.js 22 or newer.
- Claude Code CLI installed as `claude` and signed in with your Claude subscription: run `claude`, then `/login`.
- A Discord bot for this Agent Instance (see [Running alongside Codex](#running-alongside-codex)).

### Setup

```sh
# This creates a blank .inoai-connect-claude/.env and reports missing settings.
npm run validate -- --connect-dir .inoai-connect-claude
cp .env.sample .inoai-connect-claude/.env
# Edit .inoai-connect-claude/.env: set AGENT_PROVIDER=claude and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-claude
npm start -- --connect-dir .inoai-connect-claude
```

`CLAUDE_MODEL` is optional. Leave it blank to use the CLI's default model, or set a model name or alias such as `sonnet`. It must start with a letter or digit and contain only letters, digits, and `. _ : - [ ]`. Codex homes ignore it.

`npm run validate` stays offline and does not check the Claude sign-in. The credential guard runs at `npm start`.

### Credential guard

inoai accepts only the interactive Claude subscription login (`/login`). At startup it asks the CLI which credential it will use (`claude auth status`) and refuses to start, naming the source, if any of these would take over:

- an API key, such as `ANTHROPIC_API_KEY` or a Console key;
- an auth token or Anthropic profile, such as `ANTHROPIC_AUTH_TOKEN` or a token in Claude settings;
- `CLAUDE_CODE_OAUTH_TOKEN` in the environment;
- an `apiKeyHelper`;
- a cloud provider or gateway.

Each Turn checks again: if the CLI reports a non-subscription credential, the Turn fails and the thread gets a notice to run `claude /login`. inoai never reads credential files and never edits your shell, settings, or credentials. To fix a refusal, unset the variable or remove the setting locally, run `claude /login` if needed, and restart.

### Subscription login policy

Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview) says that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products. inoai offers no login. Each owner runs it on their own machine against their own locally signed-in CLI, and inoai never handles a Claude credential.

### Behavior

- Permission prompts fail closed. The CLI denies any action your Claude settings do not already allow, and the thread gets a fixed notice to use local Claude for the blocked action ([ADR 0007](docs/adr/0007-claude-matches-codex-fail-closed-approvals.md)). Your Claude settings, MCP servers, skills, and permission rules apply unchanged.
- Project guidance comes from Claude's own `CLAUDE.md` loading. inoai does not pass `AGENTS.md` to Claude.
- `agent.md` is sent on every Turn, so edits apply from the next Turn, including in existing threads.
- At startup a concurrency probe runs two short, tool-free `haiku` calls in a disposable folder, which count against your subscription usage. If it fails, inoai processes all Turns in one global FIFO queue; startup logs which mode is active.
- A thread started under a different provider is not resumed, and its notice offers `/inoai reset` or a new thread. If the thread's Claude session can no longer be found, the notice asks you to run `/inoai reset`.

### Running alongside Codex

Give each concurrently running Agent Instance its own Discord bot and token, for example one for `.inoai-connect/` (Codex) and another for `.inoai-connect-claude/`. Reusing one bot token across runtime homes is only safe when just one of them runs at a time.

## OpenCode runtime

A runtime home can drive the owner's local OpenCode CLI instead of Codex or Claude. inoai runs `opencode run --format json --standalone` for each Turn and uses whatever provider and model OpenCode is configured with ([ADR 0009](docs/adr/0009-opencode-uses-its-configured-provider.md)).

### Prerequisites

- Node.js 22 or newer.
- OpenCode installed, with `opencode` on the PATH of the shell that runs `npm start`. The default installer puts it in `~/.opencode/bin`, which a non-interactive shell may not include.
- A Discord bot for this Agent Instance (see [Running alongside other homes](#running-alongside-other-homes)).

### Setup

```sh
# This creates a blank .inoai-connect-opencode/.env and reports missing settings.
npm run validate -- --connect-dir .inoai-connect-opencode
cp .env.sample .inoai-connect-opencode/.env
# Edit .inoai-connect-opencode/.env: set AGENT_PROVIDER=opencode and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-opencode
npm start -- --connect-dir .inoai-connect-opencode
```

OpenCode has no model setting in `.env`; `CLAUDE_MODEL` is ignored. `npm run validate` stays offline and does not look for `opencode`. At `npm start`, inoai runs `opencode --version` and refuses to start with `OpenCode CLI is unavailable` if it cannot be run.

### Data and billing

inoai passes no model or provider, so OpenCode's configured default answers every Turn, and there is no credential guard.

- With the free OpenCode Zen default, nobody is billed, but Discord prompts and project context are sent to opencode.ai.
- If you later configure another provider or API key in OpenCode, inoai uses it as configured, and that provider bills you as usual.
- The free tier allows use only "from within OpenCode". inoai works today because it runs the stock CLI, but a future OpenCode change could refuse these runs. A refusal shows up as the OpenCode authentication notice in the thread.

inoai never edits OpenCode configuration and never passes `--auto`, `--yolo`, or `--dangerously-skip-permissions`.

### Behavior

- Each Turn is a standalone `opencode run` in the deployment folder. The first Turn creates the OpenCode session and later Turns resume it with `--session`. These sessions appear in OpenCode's own session list for the deployment folder.
- Project guidance comes from OpenCode's own `AGENTS.md` loading.
- OpenCode (2.0.22) ignores the `instructions` config setting, so `agent.md` is sent as a delimited block at the start of every Turn's prompt. Edits apply from the next Turn, including in existing threads.
- Permission requests fail closed. Headless OpenCode rejects any action that would need a prompt, and the thread gets a fixed notice to use local OpenCode for the blocked action. Your OpenCode settings, MCP servers, and permission rules apply unchanged.
- **OpenCode's default rules are permissive.** Out of the box they allow shell commands and file edits, and only a few actions (such as file tools outside the project or reading `.env` files) ask. So with default settings a Discord message can make OpenCode run commands and change files in the deployment folder; only the asking cases are rejected. inoai keeps your configured policy and never tightens or loosens it. For Codex-like behavior, set the actions you want gated (for example shell and edit) to `ask` in your own OpenCode configuration; inoai will then reject them with the notice above.
- An OpenCode home always processes Turns in one global FIFO queue; there is no concurrency probe.
- A thread started under a different provider is not resumed, and its notice offers `/inoai reset` or a new thread. If the thread's OpenCode session can no longer be found, the notice asks you to run `/inoai reset`.

### Running alongside other homes

Give each concurrently running Agent Instance its own Discord bot and token, for example separate bots for `.inoai-connect/` (Codex), `.inoai-connect-claude/`, and `.inoai-connect-opencode/`. Reusing one bot token across runtime homes is only safe when just one of them runs at a time.

## Documentation

- [Proposal](docs/discord-codex-cli-harness-proposal.md) — end-to-end behavior and boundaries.
- [Implementation phases](docs/implementation-phases.md) — delivery plan and test scenarios.
- [SQLite schema](docs/sqlite-schema.md) — persisted data model and audit rules.
- [Repository structure](docs/repository-structure.md) — source and deployment layout.
- [Plan review](docs/plan-review.md) — accepted product decisions.
- [Domain language](CONTEXT.md) — shared terminology.

## Deferred after V1

- Slack and Telegram adapters.
- Family access, remote Electron UI access, and cross-Agent-Instance Memory sharing.
- Scheduled multi-step Tasks.
- Cross-machine backups and Windows/Linux release packages.
