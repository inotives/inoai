# inoai Capability Structure Refactor

## Goal

Reorganize the inoai source tree around explicit feature ownership without
changing runtime behavior, CLI behavior, persistence semantics, provider
behavior, or security boundaries.

The previous refactor improved some boundaries but left implementation files
and compatibility shims directly under `src/`. This phase completes the
structural migration.

## Target layout

```text
src/
  index.ts                         # executable entrypoint only
  inoai/
    app.ts                         # thin composition and command dispatch
    agent-instance/                # deployed instance identity and lifecycle
    conversation/                  # conversations, turns, sessions, policy
    memory/                        # memory and review behavior
    heartbeat/                     # health checks and supervisor behavior
    skills/                        # skill package lifecycle and execution
    agent-runtime/                 # provider-neutral runtime behavior
    transport/                     # transport policy and message behavior
    persistence/                   # operational persistence interfaces/behavior
    migrations/                    # schema migrations
    connectors/                    # concrete external integrations
      sqlite/
      postgres/
      discord/
      agent-runtime/
      process/
      filesystem/
      macos/
    test/                          # inoai-owned tests
      <feature>/
      integration/
      acceptance/
  ui/
    pages/                         # page-level rendering and interactions
      overview/
      conversations/
      memory/
    common/                        # UI-only shared modules
    api/                            # routes, handlers, and read models
      routes/
      handlers/
      read-models/
      sqlite-read/
    server.ts                      # one local process for API and pages
    test/                           # UI-owned tests
```

## Ownership rules

- `src/index.ts` only starts the application.
- `src/inoai/app.ts` composes concrete implementations and dispatches commands;
  it contains no feature policy.
- Each feature owns its behavior and the interfaces its callers need.
- A feature may depend on another feature's interface, never its connector.
- Connectors implement feature-owned interfaces and contain external-system
  details only.
- `src/inoai/agent-instance/` owns instance identity, profile/configuration
  validation, runtime-home lifecycle, deployment readiness, and lock policy.
- `src/inoai/migrations/` owns schema migration definitions and migration
  ordering.
- `src/ui/` is a separate product surface. UI pages may call the UI API, but
  inoai backend code must not depend on UI modules.
- The UI API reads the selected Agent Instance's SQLite database read-only and
  never acquires the runtime lock or opens the operational write store.
- `src/ui/common/` is UI-only. No generic global `common`, `utils`, or
  `services` bucket is introduced.
- No production implementation files remain directly under `src/` except
  `src/index.ts` when the phase is complete.
- No compatibility shim remains unless it has an explicit, tested owner inside
  the new structure.

## Migration order

Each slice must build and pass focused tests before the next slice begins.

1. Add the new package roots, dependency rules, and architecture checks.
2. Move Agent Instance behavior and its tests.
3. Move persistence behavior, connectors, and migrations.
4. Move Agent Runtime behavior and provider connectors.
5. Move Transport behavior and the Discord connector.
6. Move Conversation behavior and its tests.
7. Move Memory, Heartbeat, and Skills.
8. Move the UI into pages, common, API, and UI tests.
9. Remove root-level compatibility shims and obsolete duplicate modules.
10. Run full acceptance checks and verify the final source inventory.

## Work packages

### 1. Establish the new layout

- Create the `src/inoai/` and `src/ui/` ownership roots.
- Move the executable entrypoint boundary to `src/inoai/app.ts` while keeping
  `src/index.ts` as the Node launcher.
- Add a focused architecture check for forbidden production files directly
  under `src/`.
- Add an import-direction check preventing inoai backend modules from importing
  UI modules.

### 2. Extract Agent Instance

- Move runtime-home, profile, configuration, identity, and lock policy into
  `src/inoai/agent-instance/`.
- Keep filesystem and macOS details behind connectors.
- Preserve deployment validation and stale-lock behavior.
- Move Agent Instance tests under `src/inoai/test/agent-instance/`.

### 3. Consolidate Persistence and migrations

- Move operational-store interfaces and behavior into
  `src/inoai/persistence/`.
- Move SQLite and PostgreSQL implementations into the matching connectors.
- Move migration definitions and discovery into `src/inoai/migrations/`.
- Isolate or remove the legacy database path only after all consumers migrate.
- Move persistence tests under `src/inoai/test/persistence/`.

### 4. Extract Agent Runtime

- Move provider-neutral runtime contracts and turn execution into
  `src/inoai/agent-runtime/`.
- Move Codex, Claude, and OpenCode process/provider integrations into
  `src/inoai/connectors/agent-runtime/`.
- Preserve provider configuration, sandbox, approval, and concurrency policy.
- Move runtime tests under `src/inoai/test/agent-runtime/`.

### 5. Extract Transport and Conversation

- Move transport contracts and policy into `src/inoai/transport/`.
- Move Discord SDK integration into `src/inoai/connectors/discord/`.
- Move conversation sessions, turns, worker logic, and prompt composition into
  `src/inoai/conversation/`.
- Preserve FIFO processing, bot filtering, allowlist behavior, and delivery
  failure handling.
- Move related tests under their matching feature directories.

### 6. Extract Memory, Heartbeat, and Skills

- Move Memory and Memory Review behavior into `src/inoai/memory/`.
- Move heartbeat checks, event recording, and supervisor behavior into
  `src/inoai/heartbeat/`.
- Move skill manifests, lifecycle, loading, and execution into
  `src/inoai/skills/`.
- Preserve SQLite source-of-truth behavior, heartbeat lock checks, skill hash
  approval, and explicit owner approval.
- Move tests under `src/inoai/test/<feature>/`.

### 7. Rebuild the UI structure without changing the UI contract

- Move the UI server and shell into `src/ui/`.
- Split Overview, Conversations, and Memory into `src/ui/pages/`.
- Put Markdown rendering, filters, formatting, and reusable UI pieces in
  `src/ui/common/`.
- Put HTTP routes, handlers, read models, and read-only SQLite access in
  `src/ui/api/`.
- Keep API and page rendering in one local process.
- Move UI tests under `src/ui/test/`.

### 8. Remove legacy structure and close the phase

- Remove root-level compatibility shims and duplicate modules.
- Remove obsolete exports and update all imports to the owning feature.
- Run the architecture checks and full verification suite.
- Record a planner handoff with source-inventory and test evidence.

## Dependency gates

```text
layout
  └── agent-instance
        └── persistence + migrations
              └── agent-runtime
                    └── transport
                          └── conversation
                                ├── memory
                                ├── heartbeat
                                ├── skills
                                └── ui
                                      └── cleanup and acceptance
```

Only the first work package is initially ready. Each later package remains
blocked until its predecessor passes focused tests and independent review.

Every work package follows the same loop:

1. Worker moves only the assigned feature and its tests.
2. Worker runs focused tests, typecheck, build, and diff checks.
3. Reviewer inspects the current diff and handoff without editing code.
4. Findings return to the same work package before the next dependency opens.
5. The final acceptance task verifies the integrated tree and behavior.

## Verification

- Existing unit, integration, and acceptance tests continue to pass after each
  slice.
- `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check` pass.
- CLI commands, Discord behavior, Agent Runtime providers, SQLite behavior,
  heartbeat behavior, and skill approval behavior remain unchanged.
- A source-inventory check confirms that production implementation files are
  grouped under `src/inoai/` or `src/ui/`.
- An import-direction check confirms that `src/inoai/app.ts` is the composition
  point and backend code does not import UI modules.
- No credentials, runtime `.env` files, or local agent data are moved into the
  repository.

## Out of scope

- New runtime features or provider behavior.
- PostgreSQL synchronization behavior.
- UI redesign or new UI product features.
- Changes to SQLite schema semantics beyond moving migration ownership.
- Replacing the existing test runner or adding a new dependency solely for
  architecture enforcement.
