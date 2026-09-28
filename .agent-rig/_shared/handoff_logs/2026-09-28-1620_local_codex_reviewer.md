---
agent: reviewer
role: reviewer
tool: codex
task: task-0011
task_title: "Phase 2: Archived record persistence"
status: handoff
---

# Review: changes requested

## Finding

`src/database.ts:346`: **medium — `createMemoryReview()` can create a range behind an already completed cursor, so a later completion moves the cursor backward.** The cross-session guard is now correct, but it only proves both boundaries are in the review Session and ordered relative to each other. It does not require the new range to begin after the Session's last completed `through_message_id`, and `messagesForMemoryReview()` deliberately uses the most recently completed Review (`completed_at DESC, id DESC`) as its cursor.

Reproduced against the built implementation: archive Session messages 1, 2, and 3; complete Review 1--3; then create and complete a valid older Review 1--2. `messagesForMemoryReview(session)` returns `[3]`, although no Message should be eligible after the completed 1--3 review. This violates the documented source range "since that Conversation's last completed recap" and can cause archive content to be reviewed again.

Require each new Memory Review's `from_message_id` to be strictly newer than the Session's last completed cursor (and add a regression test that a later older-range review is rejected or cannot move the cursor backward). Preserve the existing same-Session, active, ordered-boundary validation.

## Verification run

- `npm test -- --test-name-pattern='memory review|archives records'` — 20 passing.
- `npm run typecheck` — passing.
- `npm run build` — passing.
- `git diff --check` — passing.

The requested cross-Session boundary regression is fixed: a cross-Session `through_message_id` throws `RangeError`, and the first Session's pending Messages remain selected.
