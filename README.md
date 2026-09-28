# inoai

inoai is a local personal-agent bridge: it connects a Discord bot to a locally authenticated coding-agent CLI, beginning with Codex CLI and the owner’s ChatGPT subscription. It stores conversation history and durable agent Memory in SQLite, without using the OpenAI API.

> **Status:** Phase 1 scaffolding is implemented. Discord, Codex, SQLite persistence, and the Electron app itself remain later work.

## V1 in brief

- TypeScript core, Discord transport, and Codex CLI runtime.
- Discord `@inoai` starts a dedicated thread; follow-up messages in that thread continue the same Agent Session.
- SQLite persists users, sessions, messages, events, approvals, daily recaps, and shared agent Memory.
- Memory Review configuration is validated locally; scheduled review execution is deferred.
- Codex capability, MCP, sandbox, and approval settings come from the local Codex CLI environment. Permission requests become Discord **Approve** / **Reject** buttons.
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

`agent.md` defines the role and personality for that deployment. A project-level `AGENTS.md`, if present, remains normal project guidance for Codex.

## Agent Instances

One `.inoai-connect*` directory is one independent Agent Instance. Each has separate configuration, Discord identity, agent sessions, SQLite archive, and Memory.

```text
.inoai-connect/           # general Codex agent
.inoai-connect-planner/   # planner role
.inoai-connect-designer/  # designer role
.inoai-connect-claude/    # future Claude CLI adapter
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

## Development

During development, use the ignored repository-root `.inoai-connect/` as the persistent local runtime home. Tests must use disposable runtime homes in the system temporary directory and must not touch real development data.

### Local setup

inoai requires Node.js 22 or newer.

```sh
npm install
npm run build
```

The first validation or start creates the ignored `.inoai-connect/` runtime home with a blank `.env`, `agent.md`, and `inoai.sqlite`. Copy the value-free sample into that home and fill in the Discord values locally; never commit the resulting `.env` or any `.inoai-connect*/` directory.

```sh
npm run validate
cp .env.sample .inoai-connect/.env
# Edit .inoai-connect/.env with your local Discord values.
npm run validate
```

`npm run validate` is offline: it checks required settings, `CHAT_PROVIDER=discord`, `AGENT_PROVIDER=codex`, local `HH:MM` review time, and a positive review limit. It does not contact Discord or Codex.

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

### UI launcher

The macOS UI bundle is a sibling deployment artifact, not runtime-home data. From a packaged deployment use `inoai ui`; during development use the equivalent command below. It passes only the selected `inoai.sqlite` path to `inoai-ui.app` and does not read or change `.env`.

```sh
npm start -- ui
npm start -- ui --connect-dir .inoai-connect-planner
```

## Documentation

- [Proposal](docs/discord-codex-cli-harness-proposal.md) — end-to-end behavior and boundaries.
- [Implementation phases](docs/implementation-phases.md) — delivery plan and test scenarios.
- [SQLite schema](docs/sqlite-schema.md) — persisted data model and audit rules.
- [Repository structure](docs/repository-structure.md) — source and deployment layout.
- [Plan review](docs/plan-review.md) — accepted product decisions.
- [Domain language](CONTEXT.md) — shared terminology.

## Deferred after V1

- Claude CLI, OpenCode, Slack, and Telegram adapters.
- Family access, remote Electron UI access, and cross-Agent-Instance Memory sharing.
- Scheduled multi-step Tasks.
- Cross-machine backups and Windows/Linux release packages.
