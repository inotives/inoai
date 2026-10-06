---
agent: worker_0075
role: worker
tool: codex
task: task-0075
task_title: "Phase 6c: PostgreSQL OperationalStore for conversations and queue"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

## Implemented

- Added `PostgresOperationalStore` in `src/operational-store.ts`.
- Added async PostgreSQL implementations for user bootstrap/upsert, sessions, agent-session binding, message archival, FIFO queue claims, runtime/failure transitions, response chunk delivery, reset/recovery, events, memories, and memory reviews.
- Schema-qualified every operational query from a validated `AGENT_INSTANCE_ID`-derived schema; values remain parameterized.
- Used short transactions for recovery, queue claims, response archival, reset, completion, and review-boundary creation.
- Preserved idempotent external-message insertion, per-session/global FIFO rules, `FOR UPDATE SKIP LOCKED` claim semantics, uncertain-delivery fail-closed behavior, audit actors, and soft-delete filters.
- Sanitized PostgreSQL driver errors before returning them to callers.
- Added focused tests for schema selection/isolation, row-lock queue claims, and secret-safe error handling.

## Verification

- `npm run typecheck`
- `npm run build`
- `node --test dist/test/operational-store.test.js` (3 passing)
- `git diff --check`

## Scope notes

- Application wiring remains task 0078.
- Docker PostgreSQL integration and concurrent acceptance remain task 0079.
- No commit or push performed.
