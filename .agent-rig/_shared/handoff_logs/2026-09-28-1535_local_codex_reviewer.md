---
agent: reviewer
role: reviewer
tool: codex
task: task-0011
task_title: "Phase 2: Archived record persistence"
status: blocked
---

# Review: changes requested

## Finding

`src/database.ts:346`: **medium — `createMemoryReview()` accepts `from_message_id` and `through_message_id` from a different Session.** SQLite validates that the Message IDs exist, but not that they belong to `review.session_id`. Completing such a Review advances that Session's cursor past its own pending Messages, silently skipping archive content.

Reproduced against the built implementation: create Session A Messages `a1` (id 1) and `a2` (id 2), then Session B Message `b1` (id 3). Create a Session A review from `a1` through `b1`, complete it, then `messagesForMemoryReview(A)` returns `[]` instead of `[a2]`.

Fix `createMemoryReview()` to verify both boundary Messages exist, are active, belong to `review.session_id`, and form a nondecreasing range before inserting. Add the cross-session rejection regression test. This preserves the documented per-Conversation completed-review cursor.

## Verification run

- `npm test` — 19 passing.
- `npm run typecheck` — passing.
- `git diff --check` — passing.

All other task-0011 criteria reviewed cleanly: durable reopening, audit columns, normal-read soft-delete filtering, and transport/workspace/message duplicate delivery are covered and behave as specified.
