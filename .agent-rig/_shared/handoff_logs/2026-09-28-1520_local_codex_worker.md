---
agent: worker
role: worker
tool: codex
task: task-0011
task_title: "Phase 2: Archived record persistence"
status: done
---

Implemented the focused SQLite archive API in `src/database.ts`: User upsert for the next owner-bootstrap task, Session/Message/Event/Memory/Memory Review persistence, uniform actor and timestamp fields, normal-read soft-delete filtering, message delivery idempotency, and the completed-review source cursor.

`archiveMessage()` returns the existing active Message with `inserted: false` on duplicate `(transport, workspace_id, external_message_id)` delivery. `messagesForMemoryReview()` returns active Messages after the most recently completed review's `through_message_id` for that Session.

Added focused persistence coverage in `src/test/database.test.ts`, including reopen durability, audit fields, soft deletion, duplicate delivery, and review cursors.

Verified: `npm test` (19 passing), `npm run typecheck`, and `git diff --check`.

Tasks unlocked: task-0012 (owner allowlist bootstrap), task-0013 (Session FIFO worker), and task-0015 (Manual Memory CLI). Reviewer should inspect task-0011 before the project manager assigns those tasks.
