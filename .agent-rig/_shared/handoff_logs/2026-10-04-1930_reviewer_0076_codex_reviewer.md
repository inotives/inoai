---
agent: reviewer_0076
role: reviewer
tool: codex
task: task-0076
task_title: "Phase 6c: PostgreSQL Memory, review, events, and Manual Memory CLI"
status: blocked
---

# Review

## Result

Not approved. Task 0076 needs a focused fix and re-review.

## Findings

1. **The PostgreSQL review path has no review-engine tests.** `src/test/memory-review.test.ts` exercises only the synchronous SQLite `reviewSession`; it contains no `reviewSessionWithStore` coverage, `MemoryReviewSnapshot` fake, or `commitMemoryReview` assertions. The only new Manual Memory test uses a hand-written fake and does not exercise PostgreSQL review behavior. This leaves the required cursor, stale-range, redaction, fail-closed, and atomic-commit behavior unverified for the implementation being delivered.

2. **`readMemoryReview` is not one PostgreSQL snapshot.** In `PostgresOperationalStore`, it performs separate pool queries for the review row, cursor, messages, owners, memories, and recaps. A concurrent writer can change the archive between those queries, so the review model can receive a mixed-time snapshot. The async review contract and worker handoff explicitly claim one snapshot; use one transaction/client (or an equivalent repeatable-read snapshot) for the complete read.

3. **Concurrent new reviews can both pass the stale-cursor check.** `commitMemoryReview` reads `MAX(through_message_id)` and compares it with the caller cursor, but does not lock a per-session row or otherwise serialize commits. Two transactions can read the same cursor before either commits, both insert and complete a review over the same range, and duplicate Memory changes/events. Add a session-scoped lock/serialization mechanism and regression coverage for concurrent stale-range protection.

## Checks

- Worker-reported `npm run typecheck`, `npm run build`, focused compiled tests, and `git diff --check` are noted in the worker handoff.
- Current source inspection confirms the missing `reviewSessionWithStore` test coverage and the multi-query `readMemoryReview` implementation.
- No implementation files were edited by this review.

## Required fix

- Add fake-store tests for `reviewSessionWithStore` covering successful atomic commit, monotonic cursor/stale range, redaction/fail-closed behavior, and Manual Memory isolation where applicable.
- Make `readMemoryReview` use a single repeatable-read transaction snapshot.
- Serialize same-session `commitMemoryReview` calls (for example by locking the session row or a session-scoped advisory lock) and test the race/second-commit stale result.
- Re-run typecheck, build, focused tests, full tests, and diff checks, then write a new worker handoff for re-review.
