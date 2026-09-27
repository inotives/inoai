# Initial repository structure

```text
ino-ai/
├── AGENTS.md                         # contributor guidance for this source repository
├── README.md                          # build, deployment, and setup instructions
├── package.json                       # workspace scripts
├── tsconfig.json
├── .gitignore                         # dist/, node_modules/, and .inoai-connect/
├── docs/
│   ├── discord-codex-cli-harness-proposal.md
│   ├── implementation-phases.md
│   ├── plan-review.md
│   ├── sqlite-schema.md
│   └── repository-structure.md
├── apps/
│   ├── core/                          # published as the portable inoai executable
│   │   ├── src/
│   │   │   ├── index.ts               # bootstrap, startup, and shutdown wiring
│   │   │   ├── runtime-home.ts        # locate/init .inoai-connect/ below launch folder
│   │   │   ├── config.ts              # parse .inoai-connect/.env
│   │   │   ├── transport.ts
│   │   │   ├── transports/discord.ts
│   │   │   ├── agent.ts
│   │   │   ├── agents/codex.ts
│   │   │   ├── db.ts
│   │   │   ├── worker.ts
│   │   │   ├── memory.ts
│   │   │   ├── approvals.ts
│   │   │   └── admin.ts               # local Manual Memory commands
│   │   └── templates/
│   │       ├── agent.md               # copied for a new deployment
│   │       └── env                    # copied to .inoai-connect/.env
│   │   
│   └── ui/                            # separately started Electron + Tailwind analytics app
│       ├── src/
│       │   ├── main.ts                # Electron main process and selected-runtime access
│       │   ├── preload.ts             # narrow renderer IPC bridge
│       │   ├── db.ts                  # narrow SQLite reads and Manual Memory writes
│       │   └── renderer.ts            # Tailwind browser rendering
│       └── styles.css
└── test/
    ├── core/                          # bootstrap, schema, worker, runtime tests
    └── ui/                            # selected-runtime and analytics tests
```

## Deployment layout and runtime home

The release is deployed as a self-contained folder. The core executable is launched from the folder it should assist; `inoai ui` launches the sibling Electron bundle. The folder is Codex's project path and keeps inoai's own state in a hidden data directory:

```text
<deployment-folder>/
├── inoai                            # core executable
├── inoai-ui.app/                    # Electron bundle; macOS is the only V1 release target
├── .inoai-connect/
│   ├── .env                           # Discord and runtime configuration; never committed
│   ├── agent.md                       # inoai personality for this deployment
│   ├── inoai.sqlite                   # archive, sessions, Memory, approvals
│   └── backups/                       # three rotating local SQLite snapshots
└── ...project files Codex may inspect or work on...
```

On first run, the core creates `.inoai-connect/`, copies its `agent.md` and `.env` templates, and creates the SQLite database. It never overwrites an existing runtime home. The blank `.env` stops normal startup with a list of required values until the owner configures it.

The Electron bundle is not stored in `.inoai-connect/`; application binaries remain replaceable during upgrades while state and backups remain intact.

V1 packages this layout for macOS only. The source remains portable TypeScript, but Windows and Linux release artifacts are deferred until the macOS deployment flow is proven.

`inoai start` uses `.inoai-connect/` by default. `inoai start --connect-dir .inoai-connect-planner` selects a named Agent Instance in the same deployment folder, permitting a distinct Discord configuration, `AGENT_PROVIDER`, role-specific `agent.md`, and archive. Examples include `.inoai-connect-claude`, `.inoai-connect-planner`, and `.inoai-connect-designer`. Each runtime home is one independent bot instance: its agent sessions and Memory do not cross into another runtime home. Each home owns its own lock file: a second core for the same home refuses to start, while different homes may run independently. `inoai ui` accepts the same option.

`agent.md` is supplied explicitly to the Agent Runtime. A project-level `AGENTS.md`, if present in the deployment folder, remains Codex's normal project instruction and does not replace inoai's personality.

## Module boundaries

- `runtime-home.ts` owns only initialization and paths below `.inoai-connect/`.
- `db.ts` owns SQLite schema and persisted state for the core; `worker.ts` owns per-Session FIFO execution.
- `agent.ts` and `transport.ts` are the only provider seams.
- The Electron UI is a separate application. Its main process opens the SQLite file in an explicit local `.inoai-connect*` home directly; its renderer receives only a narrow preload API and never receives Discord credentials or raw runtime tool output. A native **Load SQLite** picker validates and switches the active Agent Instance.

## Keep out of v1

- A dashboard server inside the core executable.
- A network database, remote UI, or remote database access.
- A plugin registry, generic job queue, or migration framework.
- A `dist/` directory or any deployment `.inoai-connect/` directory in source control.

## Development runtime home

For normal local development, launch the core from the repository root and use its ignored `./.inoai-connect/` directory. It is the persistent development Discord identity, archive, and Memory database. Tests must create isolated runtime homes in the operating system temporary directory and delete them after each test; they must never read or modify the repository-root development runtime home.
