# Repository structure

This document describes the core model, the runtime home, the Discord rules,
and the source layout. For setup and commands, see
[INSTRUCTIONS.md](../INSTRUCTIONS.md).

## Core model

Deploy inoai into the folder it should assist. Each hidden runtime directory is one independent Agent Instance with its own configuration, Discord identity, and SQLite database.

On first start, the core creates the runtime home from bundled templates and never overwrites an existing one. It opens the runtime home's `inoai.sqlite`, creates a missing database through the existing schema path, and reuses existing SQLite data. There is no automatic PostgreSQL-to-SQLite migration. One core process owns each runtime home and holds its lock. The UI reads the database and writes only Tasks, through short-lived connections (ADR 0026). While the core runs, the local `allowlist:add`, `allowlist:disable`, `memory add`, and `memory delete` commands also write through short-lived connections (ADR 0025); do not stop the core for them. A write waits up to 5 seconds for SQLite; if it reports a retryable busy error, run the command again. Runtime homes are git-ignored and must never be committed. Do not share one runtime home between machines.

`agent.md` defines that instance's role and personality. Project guidance comes from each CLI's own loading: `AGENTS.md` for Codex and OpenCode, `CLAUDE.md` for Claude.

## Deployment layout and runtime home

The release is deployed as a self-contained folder. The core executable is launched from the folder it should assist; `inoai ui` serves the local UI page from the same executable. The folder is the agent CLI's project path and keeps inoai's own state in hidden runtime homes:

```text
<deployment-folder>/
├── inoai                          # portable core executable
├── .inoai-connect/                # general Codex agent (default runtime home)
│   ├── .env                       # Discord and runtime configuration; never committed
│   ├── agent.md                   # inoai personality for this deployment
│   ├── inoai.sqlite               # archive, sessions, Memory, approvals, Tasks
│   ├── inoai.lock                 # owning-process lock
│   ├── backups/
│   └── results/                   # Task files by Task ID and Run ID
├── .robin-xai-test/               # Robin-XAI test instance (with its own results/)
├── .inoai-connect-claude/         # Claude CLI adapter (Phase 5a)
├── .inoai-connect-opencode/       # OpenCode CLI adapter (Phase 5b)
└── ...project files the agent CLI may inspect or work on...
```

On first run, the core creates `.inoai-connect/`, copies its `agent.md` and `.env` templates, and creates the SQLite database. It never overwrites an existing runtime home. The blank `.env` stops normal startup with a list of required values until the owner configures it.

Application files are not stored in `.inoai-connect/`; they remain replaceable during upgrades while state and backups remain intact.

V1 packages this layout for macOS only. The source remains portable TypeScript, but Windows and Linux release artifacts are deferred until the macOS deployment flow is proven.

`inoai start` uses `.inoai-connect/` by default. `inoai start --connect-dir .inoai-connect-planner` selects a named Agent Instance in the same deployment folder, permitting a distinct Discord configuration, `AGENT_PROVIDER`, role-specific `agent.md`, and archive. Examples include `.inoai-connect-claude`, `.inoai-connect-planner`, and `.inoai-connect-designer`. Each runtime home is one independent bot instance: its agent sessions and Memory do not cross into another runtime home. Each home owns its own lock file: a second core for the same home refuses to start, while different homes may run independently. `inoai ui` accepts the same option.

`agent.md` is supplied explicitly to the Agent Runtime. A project-level `AGENTS.md`, if present in the deployment folder, remains Codex's normal project instruction and does not replace inoai's personality.

### Runtime home lock

The local `inoai.lock` is a `0600` JSON record containing the owning process
PID, its macOS process start time, and a release token. If startup finds an
existing lock, it reclaims it only when that exact process is gone or its
start time no longer matches (protecting against PID reuse). Recovery runs
only during startup; there is no lock refresher. Legacy UUID-only and malformed
locks cannot be verified safely and remain locked until removed deliberately.
Normal startup does not acquire a PostgreSQL lease.

## Discord rules

- Multiple agent bots may share a channel. Each reacts only to its own top-level `@label` mention and owns only the threads it created.
- A mention of another bot inside an existing thread is not a handoff; start that agent from a new top-level message instead. A top-level message mentioning several agent bots creates nothing.
- Bots ignore bot-authored messages, which prevents agent-to-agent loops.
- V1 admits the configured owner and explicitly allowlisted family users.
- An owner mention starts a conversation in any accessible channel of the configured server except the status-only channel. Ordinary top-level messages do nothing; follow-ups in a bound thread need no mention.

## Source layout

The source layout follows [ADR 0022](adr/0022-inoai-source-layout.md). Tests sit
beside the code they cover in `test/` folders.

```text
inoai/
├── AGENTS.md                         # contributor and coding-agent guidance
├── CONTEXT.md                        # domain language
├── INSTRUCTIONS.md                   # setup, commands, and operations
├── README.md                         # overview and docs map
├── logo.svg
├── package.json                      # npm scripts
├── package-lock.json
├── tsconfig.json
├── .env.sample                       # runtime-home .env template for manual setup
├── .gitignore                        # dist/, node_modules/, .inoai-connect*/, and more
├── docker-compose.yml                # advanced PostgreSQL tooling only
├── migrations/                       # advanced PostgreSQL SQL migrations
├── scripts/
│   └── check-source-architecture.mjs # `npm run architecture:check`
├── docs/
│   ├── adr/                          # architecture decision records
│   ├── agent-deployment-provisioning-plan.md
│   ├── archived/                     # completed phase plans and CLI spikes
│   ├── discord-codex-cli-harness-proposal.md
│   ├── implementation-phases.md
│   ├── note__runtime-sqlite-live-writes.md
│   ├── postgres-local.md
│   ├── repository-structure.md
│   └── sqlite-schema.md
├── trinary-workspace/backlog/        # committed backlog; the rest of trinary-workspace/ is ignored
└── src/
    ├── index.ts                      # executable entrypoint; `ui` goes to src/ui, all else to src/inoai/app.ts
    ├── inoai/                        # core backend
    │   ├── app.ts                    # composition root and CLI wiring
    │   ├── agent-instance/           # config, identity, profile, runtime home and lock
    │   ├── agent-runtime/            # provider-neutral runtime port
    │   ├── conversation/             # Session, Turn, FIFO worker, prompt context, Task runs and proposal cards
    │   ├── heartbeat/                # optional Heartbeat Supervisor and LaunchAgent
    │   ├── memory/                   # Daily Memory Review and Memory operations
    │   ├── persistence/              # operational store contract
    │   ├── skills/                   # skill acquisition, approval, and loading
    │   ├── tasks/                    # Task schedules and chat task blocks
    │   ├── transport/                # transport port, inbound policy, approval relay
    │   ├── migrations/               # PostgreSQL migration runner
    │   ├── connectors/
    │   │   ├── agent-runtime/        # Codex, Claude, and OpenCode adapters; concurrency probe
    │   │   ├── discord/              # Discord transport adapter
    │   │   └── persistence/
    │   │       ├── sqlite/           # SQLite schema, queries, and operational store
    │   │       └── postgres/         # advanced PostgreSQL tooling
    │   └── test/                     # backend tests by capability
    ├── ui/                           # local UI page (`npm start -- ui`)
    │   ├── README.md
    │   ├── server.ts                 # HTTP server on loopback or one selected private LAN address
    │   ├── api/                      # SQLite read model and Task writes (ADR 0026)
    │   ├── common/                   # UI-only options
    │   ├── pages/                    # page rendering
    │   └── test/
    ├── test/                         # cross-capability and acceptance tests
    ├── persistence/                  # README only
    └── platform/                     # README only
```

## Module boundaries

- `src/inoai/agent-instance/runtime-home.ts` owns runtime-home initialization, paths, and the lock.
- `src/inoai/connectors/persistence/sqlite/` owns the SQLite schema and persisted state for the core; `src/inoai/conversation/conversation-worker.ts` owns per-Session FIFO execution.
- `src/inoai/agent-runtime/ports.ts` and `src/inoai/transport/ports.ts` are the provider seams. Concrete adapters live under `src/inoai/connectors/`.
- `src/inoai/` never imports `src/ui/`. `npm run architecture:check` enforces this and allows only `index.ts` directly under `src/`.
- The UI is a separate application: `inoai ui` serves it on `127.0.0.1` by default, or on one private LAN IPv4 address selected with `--host`. It opens the SQLite file of the selected `.inoai-connect*` home through short-lived connections. It reads that data and writes only Tasks (ADR 0026). It never reads `.env` and never sends Discord credentials or raw runtime tool output to the page. Every request needs the bound address and port in `Host`; the loopback default also accepts `localhost:<port>`. Any other Host gets 403. `/` accepts GET and HEAD, `/api/ui-data` accepts GET, other methods get 405, and unknown paths get 404. `--connect-dir` selects the Agent Instance. LAN mode has no password; any device that can reach the selected address can read data and change Tasks.

## Keep out of v1

- A dashboard server inside the running core process. `inoai ui` runs as its own process.
- A network database, remote UI, or remote database access.
- A plugin registry, generic job queue, or migration framework.
- A `dist/` directory or any deployment `.inoai-connect/` directory in source control.

## Development runtime home

For normal local development, launch the core from the repository root and use its ignored `./.inoai-connect/` directory. It is the persistent development Discord identity, archive, and Memory database. Tests must create isolated runtime homes in the operating system temporary directory and delete them after each test; they must never read or modify the repository-root development runtime home.
