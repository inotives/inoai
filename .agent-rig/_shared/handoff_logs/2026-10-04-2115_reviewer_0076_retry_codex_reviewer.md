---
agent: reviewer_0076_retry
role: reviewer
tool: codex
task: task-0076
task_title: "Phase 6c: PostgreSQL Memory, review, events, and Manual Memory CLI"
status: blocked
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Re-review

## Result

Not approved. Task 0076 still needs a focused fix and re-review.

## Findings

1. **The requested concurrency regression is still missing.** `commitMemoryReview` now calls `pg_advisory_xact_lock(hashtext(...))`, but no test exercises two same-session commits or demonstrates that the second commit observes the advanced cursor and returns `stale_range`. The existing stale test is a hand-written store whose `commitMemoryReview` unconditionally returns `stale_range`; it does not verify the PostgreSQL implementation or the advisory lock.

2. **The requested transaction-snapshot regression is still missing.** `readMemoryReview` now begins `REPEATABLE READ` and commits after all reads, which is directionally correct, but no store-level test asserts the transaction boundaries and that every review-input query runs through the same connected client. The existing `fakePool` tests cover queue transactions only.

3. **Full-suite verification is not clean.** `npm test` fails before the BigQuery test because `@google-cloud/bigquery` cannot be resolved from `src/bigquery.ts`; the current `package.json` has no `@google-cloud/bigquery` dependency. Focused task tests pass (28), and `npm run typecheck`, `npm run build`, and `git diff --check` pass. This dependency issue may be pre-existing/deferred scope, but the handoff cannot claim a clean full suite until it is either restored or explicitly isolated and documented by the planner.

## Checks

- `npm run typecheck` — passed.
- `npm run build` — passed.
- Focused compiled tests (`memory-review`, `memory-cli`, `operational-store`) — 28 passed.
- `npm test` — failed: missing `@google-cloud/bigquery` module in `dist/test/bigquery.test.js`.
- `git diff --check` — passed.

## Required fix

- Add a fake-client/store regression test that proves `readMemoryReview` issues `BEGIN ISOLATION LEVEL REPEATABLE READ`, all snapshot queries on the same client, then `COMMIT` (and rolls back on failure).
- Add a store-level race test (or deterministic two-client simulation) proving the advisory lock serializes same-session commits and the second stale commit does not duplicate the review/memory/event.
- Resolve or explicitly document the missing BigQuery dependency so full-suite status is honest; rerun typecheck, build, focused tests, full tests, and diff checks.
- Write a new worker handoff before re-review.

No implementation files were edited by this review.
