---
agent: refactor_slice2_worker
role: worker
tool: codex
task: task-0096
task_title: "Read docs/source-structure-refactor-plan.md — Slice 2: isolate persistence boundary"
status: handoff
---

## Summary

Grouped persistence implementations under `src/persistence/` while preserving
runtime behavior and explicit compatibility entry points:

- `persistence/operational-store.ts` is the PostgreSQL-backed operational
  `OperationalStore` boundary.
- `persistence/legacy-database.ts` is explicitly labeled as legacy/UI SQLite
  persistence and is not used as the operational store.
- PostgreSQL pool, lease, migration, provisioning, and connection-test modules
  now live under the same persistence capability.
- Root modules remain small compatibility/CLI entry points so existing imports
  and npm scripts continue to work. The migration wrapper preserves the
  repository-level migrations path after the move.
- Capability modules now import persistence paths directly; a focused test
  verifies the separated entry points.

## Changed files

- Added `src/persistence/README.md`.
- Moved implementations into `src/persistence/` and added root compatibility
  wrappers for `database`, `operational-store`, `postgres`, lease, migration,
  provisioning, and connection-test modules.
- Updated application and capability imports to use the persistence boundary.
- Added `src/test/persistence-boundary.test.ts`.

## Verification

- `npm test` — 222 passed, 2 skipped, 0 failed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.
- CLI smoke checks — provisioning wrapper emitted SQL; migration wrapper
  retained its usage failure behavior without a URL.

## Scope and residual risk

No schema, query, provider, transport, or runtime behavior was intentionally
changed. Existing AgentRig SQLite files, Slice 1 changes, and planner docs are
pre-existing worktree changes and were not staged or committed.
