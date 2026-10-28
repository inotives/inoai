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
  <a href="INSTRUCTIONS.md">Instructions</a>
  ·
  <a href="docs/repository-structure.md">Architecture</a>
  ·
  <a href="docs/implementation-phases.md">Implementation Phases</a>
  ·
  <a href="docs/adr/">ADRs</a>
  ·
  <a href="CONTEXT.md">Domain Language</a>
</p>

---

## What It Is

inoai is a local personal-agent bridge. It connects a Discord bot to a coding-agent CLI that is already installed and signed in on your machine, and it keeps operational conversation history and durable agent Memory in local SQLite.

It drives the CLI you already use instead of calling a model API. Codex runs on your ChatGPT sign-in, Claude Code on your Claude subscription, and OpenCode on whatever provider it is configured with. inoai itself never calls the OpenAI or Anthropic API, and it never loosens the CLI's own permission policy.

- An `@inoai` mention starts a dedicated Discord thread, and follow-ups in that thread continue the same Agent Session.
- SQLite records users, sessions, messages, events, approvals, daily Recaps, and shared Memory, with audit fields and soft deletion in each runtime home.
- A complete, safe Codex command request can show owner-only Discord **Approve** / **Reject** buttons for that one live request. File changes, network or extra permission requests, malformed previews, and Claude/OpenCode prompts still fail closed.
- A silent Daily Memory Review turns each Agent Session's new Messages into a Recap and, when warranted, shared Memory.
- Owner-only Tasks run once on command or recur on a whole-hour or whole-day interval. Each Task has its own Discord thread and Agent Session.
- A UI page, started with `npm start -- ui`, reads the selected runtime home's SQLite database and can manage Tasks. It binds to loopback by default or one selected private LAN address with `--host`; SQLite is the core runtime's source of truth.

Status: Conversation workers, Codex, Claude CLI, OpenCode, Daily Memory Review (Claude homes only in V1), Tasks, and the local UI are implemented. The runtime uses SQLite. PostgreSQL tools remain available for advanced testing; the later central reporting sink and V1 hardening remain.

## Quick Start (Codex)

On Apple Silicon, the [standalone macOS CLI](INSTRUCTIONS.md#standalone-macos-cli)
runs without installing Node or cloning this repository. It guides you through
creating an agent and starts the agent and UI together.

For a source checkout, you need Node.js 22 or newer on macOS, a Discord bot,
and a signed-in `codex` CLI.

```bash
npm install
npm run build
npm run validate                      # creates .inoai-connect/ and lists missing settings
cp .env.sample .inoai-connect/.env    # then edit it with your local Discord values
npm run validate
npm start
```

For Claude, OpenCode, skills, Tasks, the local UI, the Heartbeat Supervisor, and all commands, see [INSTRUCTIONS.md](INSTRUCTIONS.md).

## Documentation

| Document | Contents |
| --- | --- |
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | Setup per provider, commands, Tasks, Heartbeat Supervisor, Daily Memory Review, upgrading agent CLIs, development. |
| [docs/repository-structure.md](docs/repository-structure.md) | Core model, runtime home and lock, Discord rules, source layout, module boundaries. |
| [CONTEXT.md](CONTEXT.md) | Domain language. |
| [docs/discord-codex-cli-harness-proposal.md](docs/discord-codex-cli-harness-proposal.md) | V1 behavior and boundaries. |
| [docs/implementation-phases.md](docs/implementation-phases.md) | Implementation phases and delivery status. |
| [docs/adr/](docs/adr/) | Architecture decision records. |
| [docs/sqlite-schema.md](docs/sqlite-schema.md) | Runtime SQLite schema. |
| [docs/postgres-local.md](docs/postgres-local.md) | Advanced PostgreSQL tools. |
| [AGENTS.md](AGENTS.md) | Contributor and coding-agent guidelines. |

Deferred after V1: Slack and Telegram adapters; Internet UI access and cross-instance Memory sharing; multi-step Task loops and calendar schedules; cross-machine backups and Windows/Linux release packages.
