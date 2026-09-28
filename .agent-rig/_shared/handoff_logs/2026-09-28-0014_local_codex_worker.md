---
agent: worker
role: worker
tool: codex
task: task-0014
task_title: "Phase 2: Stale-work recovery"
status: done
---

# Task 0014 ready for review

Added `recoverStaleWork` in `src/database.ts`. Each database open now atomically returns non-deleted `processing` rows in `messages` and `memory_reviews` to `pending`, updates the audit modifier to `startup-recovery`, and retains the original rows and timestamps.

Added a focused restart test that persists one processing Message and Memory Review, closes the database, then opens it again and verifies both are pending while their original history remains.

Verified:

- `npm test` (27 passing)
- `npm run typecheck`
- `npm run build`
- `git diff --check`

No scheduler, job system, transport behavior, or task definitions were added beyond task 0014's status.
