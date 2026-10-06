---
agent: reviewer
role: reviewer
tool: codex
task: task-0020
task_title: "Phase 3: Top-level mention conversation creation"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0020 review

## Findings

1. **High — failed persistence leaves an unbound Discord thread and breaks retry idempotency.** `src/index.ts:69-93` creates the thread before starting the SQLite transaction. If `BEGIN IMMEDIATE`, `createSession`, or `archiveMessage` fails, the catch only logs the error. The thread remains in Discord with no Session or queued Message. Redelivery then sees no initiating-message row and creates another thread. This violates the one-thread/Conversation boundary for a request and the duplicate-delivery criterion in the failure path. Add a compensating cleanup or a durable recovery/reconciliation path; cover a forced database failure after successful thread creation and redelivery.

2. **Medium — shutdown does not wait for an accepted request to finish.** `src/index.ts:67-97` launches ingestion without tracking its promise, while `src/index.ts:191-200` stops transport and closes SQLite immediately. If shutdown occurs while `createConversation` is pending, it may subsequently return a new thread ID and then fail against the closed database, again leaving no Session/Message. Track and drain in-flight creation before database close, with a focused shutdown regression check.

The normal path and concurrent/later duplicate guard are otherwise consistent with task 0020. The eligibility policy is applied before any thread creation, and this path does not invoke an Agent Runtime.

## Verification

- `npm test`: 42 passed, 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- No implementation edits or task status change.
