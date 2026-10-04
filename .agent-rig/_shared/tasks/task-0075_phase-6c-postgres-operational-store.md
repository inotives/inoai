---
id: task-0075
title: "Phase 6c: PostgreSQL OperationalStore for conversations and queue"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0074
message: Independent review clean. Focused store tests (3), typecheck, build,
  and diff check passed; repository-wide npm test has unrelated missing BigQuery
  dependency noted in reviewer handoff.
---





# Task

## Goal

Move conversation persistence, Session identity, Message archival, FIFO claims, response delivery state, and recovery onto PostgreSQL.

## Scope

- Implement async PostgreSQL OperationalStore methods for current conversation-worker behavior.
- Preserve per-Session FIFO and global fallback semantics.
- Preserve idempotency, uncertain delivery handling, soft deletes, and audit actors.
- Use short transactions and parameterized queries only.
- Keep Discord and Agent Runtime behavior unchanged at the transport boundary.

## Acceptance Criteria

- [ ] Conversation and queue tests pass against a fake store and Docker PostgreSQL.
- [ ] Duplicate provider events remain idempotent.
- [ ] Concurrent claims cannot process one Message twice.
- [ ] Runtime failures and uncertain delivery remain fail-closed.
- [ ] No SQL or database error leaks secrets.
