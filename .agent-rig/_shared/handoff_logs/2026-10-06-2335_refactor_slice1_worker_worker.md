---
agent: refactor_slice1_worker
role: worker
tool: codex
task: task-0095
task_title: "Read docs/source-structure-refactor-plan.md — Slice 1: extract application composition root"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T15:37:49.150Z
---

## Summary

Extracted the application composition root from `src/index.ts` into
`src/app/application.ts`. The new application module retains the existing
exports and runtime wiring; `src/index.ts` is now a thin executable entry point
that re-exports the application API for existing test/import consumers and
delegates CLI execution to `run`.

## Changed files

- `src/app/application.ts`: moved the existing composition, CLI parsing,
  startup, transport, runtime, memory, and shutdown implementation; adjusted
  relative imports for the new directory and removed the old module's main
  guard.
- `src/index.ts`: imports/re-exports the application module and owns the
  executable main guard.

No behavior, CLI syntax, provider wiring, persistence contract, runtime-home
lock/lease behavior, or shutdown behavior was intentionally changed.

## Verification

- `npm test` — 221 passed, 2 skipped, 0 failed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Review notes

Generated AgentRig SQLite files and pre-existing documentation changes remain
unstaged and were not modified by this task.
