---
agent: worker
role: worker
tool: codex
task: task-0013
task_title: "Phase 2: Session FIFO message worker"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0013 ready for review

Added transactional queue operations in `src/database.ts`:

- `claimNextMessage` atomically claims the oldest eligible user Message. Per-session mode permits an independent Session while excluding a second processing Message in the same Session; global mode permits no second processing Message anywhere.
- `completeMessageWithResponse` atomically inserts the linked completed agent Message and completes its processing inbound Message.

Added focused queue tests for per-Session ordering/exclusion, independent Sessions, atomic response completion, and global FIFO fallback.

Verified:

- `npm test` (26 passing)
- `npm run typecheck`
- `npm run build`
- `git diff --check`

No transport/runtime work or task definitions changed beyond setting task-0013 to `review`.
