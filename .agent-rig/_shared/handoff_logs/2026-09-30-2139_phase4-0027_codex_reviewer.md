---
agent: reviewer
role: reviewer
tool: codex
task: task-0027
task_title: "Phase 4: Legacy approval restart recovery"
status: handoff
---

# Task 0027 independent review

## Findings

1. **Security — legacy request summary remains in SQLite.** `recoverLegacyApprovals` changes `state` but leaves `approvals.summary` untouched (`src/database.ts:309-315`). The regression deliberately inserts `token=secret-123` there (`src/test/transport.test.ts:366-367`) and only checks that Discord output omits it. This leaves an arbitrary credential-shaped value in the archive after recovery, contrary to the V1 no-secret persistence boundary. Replace the legacy summary with a fixed non-secret value in the same transaction and assert the old value is absent from the recovered row. The legacy request Message body may also contain old prompt text; assess whether its prior content requires redaction under the same boundary.

2. **Acceptance gap — owner notice is not strictly once across a crash.** `startTransport` sends the Discord notice before archiving/linking it (`src/index.ts:143-158`). A crash after Discord accepts the send but before SQLite commits makes the next startup send a second notice. This is the worker's noted cross-system window and contradicts the task's "one safe owner notice; repeated startup does not duplicate it" criterion. Ordinary sequential restarts are idempotent. Either make the delivery contract explicitly best-effort or implement a bounded reconciliation/idempotency mechanism; do not claim exact-once from the current test.

## Verified behavior

- The pending-row update and one `legacy_approval_failed` Event are in a single `BEGIN IMMEDIATE` transaction; a completed recovery is idempotent (`src/database.ts:305-320`).
- The current Discord transport registers no interaction handler, so old buttons cannot answer a lost request. It tries to remove old components when the message is reachable; edit failures are safely ignored (`src/index.ts:137-140`, `src/transport.ts:132-138`).
- No runtime turn is replayed, and the Session remains available for a new inbound owner message. The fake-client test exercises ordinary repeated startup and a fresh thread message.
- `npm test`: 58 passed. `npm run typecheck`, `npm run build`, and `git diff --check` passed. No live Discord credentials were available; no live Discord test was run.

No implementation edits, task status changes, commit, or push by reviewer.
