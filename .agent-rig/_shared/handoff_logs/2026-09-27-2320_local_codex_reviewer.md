---
agent: reviewer
role: reviewer
tool: codex
task: task-0003
task_title: "Phase 1: Runtime home bootstrap"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0003 final re-review handoff

Task 0003 has one remaining P2 finding. The CLI alternate-home, symlink rejection, and sequential stale-release fixes are covered; `npm test` (8 tests), `npm run typecheck`, and `git diff --check` pass.

- `src/runtime-home.ts:83-87` — two concurrent calls to the same returned `release` closure can both read the original token. One removes it, a successor acquires the lock, then the other removes the successor lock. Serialize or memoize release before its read/remove sequence, and add a concurrent-release regression test.

The implementation remains uncommitted.

## Suggested skills

- `tdd` for the concurrent-release regression.
- `ponytail` for a one-shot release guard.
- `review` after the lock fix is ready.
