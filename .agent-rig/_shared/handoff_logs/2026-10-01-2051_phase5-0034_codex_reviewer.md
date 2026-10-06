---
agent: reviewer
role: reviewer
tool: codex
task: task-0034
task_title: "Phase 5: Cross-session concurrency fallback"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0034 independent review

## Finding (blocking)

1. `src/concurrency-probe.ts:48-52`: The success predicate only checks that both `turn/started` notifications precede both `turn/completed` notifications. A server that emits both start notifications while admitting turns, then executes the two `sleep 8` commands serially, produces `started A, started B, completed A, completed B` and passes this predicate despite no concurrent work. This can enable per-Session scheduling without the required real concurrency proof. Require evidence that the read-only work itself overlapped (or fail closed when that evidence is unavailable), and add a deterministic probe test for the serialized-execution/early-start sequence. Do not rerun the lengthy real probe merely to validate this logic fix.

## Checks and scope

- `npm test`: 77 passed, 0 failed.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Reviewed scheduler, SQLite claim guard, startup integration, and probe. The scheduler defaults to global on new worker construction; the claim query excludes a second processing Message in the same Session. Fallback waits for already-active turns to settle before new global claims. No separate scheduler finding.
- The worker's actual authenticated probe result was `false`/unavailable after 613.539 seconds before its later timeout cap. This does **not** validate cross-Session concurrency; current production mode remains global FIFO. I did not repeat the live probe.
- Review made no implementation edits, task-status changes, commit, or push.
