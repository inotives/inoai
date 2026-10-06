# Source Structure Refactor Plan

## Purpose

Make the inoai TypeScript codebase easier to navigate, test, and extend while
preserving all current behavior. This is a structural refactor, not a product
feature or persistence migration.

The governing decisions are in [ADR 0016](adr/0016-behavior-preserving-capability-modules.md).

## Invariants

The refactor must not change:

- Discord message routing, authorization, threading, or bot-message filtering.
- Agent Runtime provider behavior, CLI arguments, skills, MCP configuration,
  sandbox, or approval policy.
- Agent Session and Turn lifecycle, FIFO behavior, cancellation, reset, or
  recovery semantics.
- SQLite/PostgreSQL operational persistence contracts or analytics sink behavior.
- Runtime-home lock and PostgreSQL lease ownership behavior.
- CLI commands, configuration names, environment variables, or startup errors.
- Security boundaries, secret handling, or log redaction.

## Target structure

```text
src/
  index.ts             thin executable entry point
  app/                 CLI commands, startup, composition root
  conversation/        sessions, turns, worker orchestration
  memory/              review policy, scheduler, prompts, memory operations
  persistence/         operational store, legacy SQLite, migrations, sinks
  runtime/             provider interface and Codex/Claude/OpenCode adapters
  transport/            Discord adapter and inbound/outbound policy
  platform/             config, runtime home, identity, leases
```

The names describe capability boundaries, not generic technical layers. Avoid
new `utils`, `helpers`, or catch-all `services` directories.

## Dependency rules

1. `index.ts` delegates immediately to the application composition entry point.
2. `app` is the composition root and may import concrete implementations.
3. Capability modules depend on narrow interfaces and stable application types.
4. Infrastructure implementations live at the edges of their capability.
5. `OperationalStore` remains the only operational persistence interface.
6. The older `database.ts` implementation is isolated as legacy/UI SQLite code
   and gains no new operational consumers.
7. Capability entry points are explicit; do not add broad barrel exports.
8. No new import-boundary dependency is required initially. TypeScript,
   focused architecture tests, directory conventions, and review enforce the
   rules until a repeated violation justifies tooling.

## Implementation sequence

### Slice 1: composition root

Extract CLI parsing, startup validation, runtime-home lifecycle, dependency
construction, and shutdown from `src/index.ts` into `app`. Keep all existing
module locations and behavior unchanged. `src/index.ts` should only invoke the
application entry point.

### Slice 2: persistence boundary

Move or group persistence implementations under `persistence` without
changing schemas or query behavior. Keep `OperationalStore` as the stable
interface and clearly label legacy/UI SQLite code. Add focused construction and
contract checks.

### Slice 3: conversation boundary

Group session, turn, and worker orchestration under `conversation`. Preserve
per-session FIFO, cancellation, reset, retry/recovery, and handoff behavior.

### Slice 4: runtime and transport boundaries

Move provider adapters and Discord integration behind their existing seams.
Preserve provider-specific command construction, authorization, message
filtering, thread mapping, and outbound status behavior.

### Slice 5: memory boundary

Separate memory-review policy, prompt construction, scheduling, persistence,
and runtime execution under `memory`. Preserve review safety gates, scheduler
priority, archive semantics, and fail-closed behavior.

### Slice 6: integrated architecture verification

Run the complete test, typecheck, build, diff, and live-safe acceptance suite.
Verify that no secrets, runtime data, generated SQLite sidecars, or unrelated
files are staged. Record the final architecture review in an AgentRig phase
handoff.

## Task requirements

Each AgentRig task must:

- change one boundary or one independently verifiable seam;
- declare explicit `depends_on` edges;
- include focused tests for moved or extracted behavior;
- leave downstream tasks blocked until its worker and reviewer are clean;
- include a worker handoff and an independent reviewer handoff;
- avoid commits, pushes, and unrelated cleanup.

The final reviewer task owns only integrated verification and documentation; it
does not introduce new implementation scope.

## Acceptance criteria

- All existing tests pass with no newly skipped coverage.
- Typecheck and production build pass.
- Focused tests cover each extracted composition or capability seam.
- CLI, Discord, provider, persistence, lock, lease, and recovery behavior are
  unchanged by regression tests or documented live checks.
- Import direction matches the dependency rules above.
- `src/index.ts` is a thin executable entry point.
- No credentials, runtime-home data, SQLite sidecars, or unrelated changes are
  committed.
- The phase handoff lists every task, verification command, and resolved review
  finding.

## Explicit non-goals

- No new user-facing feature or command.
- No database replacement, schema migration, or analytics redesign.
- No Electron UI redesign.
- No scheduled-task implementation.
- No provider behavior changes or new agent adapter.
- No global configuration changes.
