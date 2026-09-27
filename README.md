# inoai

inoai is a local personal-agent bridge: it connects a Discord bot to a locally authenticated coding-agent CLI, beginning with Codex CLI and the owner’s ChatGPT subscription. It stores conversation history and durable agent Memory in SQLite, without using the OpenAI API.

> **Status:** V1 is designed and documented; implementation has not started.

## V1 in brief

- TypeScript core, Discord transport, and Codex CLI runtime.
- Discord `@inoai` starts a dedicated thread; follow-up messages in that thread continue the same Agent Session.
- SQLite persists users, sessions, messages, events, approvals, daily recaps, and shared agent Memory.
- A silent daily Memory Review runs at 06:00 in the host machine’s local time.
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
inoai start --connect-dir .inoai-connect-planner
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

The Electron UI has a **Load SQLite** action to switch between Agent Instances. It reads only `inoai.sqlite`, never a runtime home’s `.env`.

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
