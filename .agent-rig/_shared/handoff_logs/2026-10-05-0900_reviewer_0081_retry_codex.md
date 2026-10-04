---
agent: reviewer_0081_retry
role: reviewer
tool: codex
task: task-0081
task_title: "Phase 6c: migrate runtime consumers to the async PostgreSQL store"
status: blocked
---

## Review result

Blocked. The async fixture conversion removes the TypeScript errors, but the
task is not ready to pass review.

## Blocking findings

1. `npm test` is not green. The current run reports broad failures across
   ConversationWorker, Memory Review scheduler, response delivery, transport,
   and startup tests. `npm run typecheck`, `npm run build`, and `git diff --check`
   pass.

2. `src/index.ts` now creates a PostgreSQL pool and eagerly calls
   `store.bootstrapOwner()` from `start()`. This is startup/source-of-truth
   wiring and belongs to task-0078, not consumer migration task-0081. It causes
   existing startup/transport tests that use the intentionally unreachable
   `example.test` fixture URL to fail before they can exercise their intended
   runtime behavior. Keep task-0081 focused on consumer seams; defer eager
   PostgreSQL startup and test dependency injection to task-0078.

3. The async test fixture does not preserve the old test synchronization
   contract. `ConversationWorker.wake()` schedules an async pump but
   `idle()` can return before that pump has claimed/processed a message.
   `MemoryReviewScheduler.start()`/`poke()` similarly schedule async work while
   `idle()` only observes the active review. This produces assertions against
   `processing`/empty state before the operation settles. Either track and
   await the scheduled pump/cycle promises in the production boundaries or
   update tests to await an explicit settled operation; do not leave timing
   races in the suite.

4. `src/test/sqlite-store.ts` implements `commitMemoryReview()` as an
   unconditional `{ state: "stale_range" }`. That cannot model successful
   review commits and makes the converted scheduler tests fail independently
   of PostgreSQL. The fixture needs a faithful atomic fake (or focused tests
   that explicitly stub the intended result) for completed, stale, and commit
   error paths.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm test`: failed with the findings above.
- No implementation edits, credentials, commit, or push made by reviewer.

## Required follow-up

- Return task-0081 to `in_progress` and remove/revert the task-0078 startup
  wiring from this task, or explicitly split it into task-0078-owned changes.
- Make async worker/scheduler test synchronization deterministic.
- Replace the incomplete SQLite-backed async fixture commit behavior.
- Re-run the full test suite, typecheck, build, and diff checks before review.
