---
id: T-0001
feature: IP-0001
title: Persist Task and Task Run state in SQLite
status: ready
depends_on: []
---

# T-0001: Persist Task and Task Run state in SQLite

Feature plan: [IP-0001](../../README.md)

## Context

The local SQLite Operational Database owns durable Agent Instance state. The database and operational-store interfaces already define audit fields, soft deletion, sessions, messages, and state transitions. Tasks are not currently persisted.

## Goal

Add durable, recoverable Task and Task Run records for one-time and interval-recurring work.

## Scope

- Add the SQLite schema changes and the smallest migration path that preserves existing runtime homes.
- Add Task records for goal, type, interval, lifecycle state, Conversation/Session association, next due time, message cursor, and audit fields.
- Add Task Run records for lifecycle state, timestamps, bounded non-secret failure detail, and generated artifact paths.
- Add store methods needed to create, read, list, claim, complete, fail, pause, resume, cancel, and recover Tasks and Task Runs.
- Prevent more than one active Task Run per Agent Instance and preserve soft-delete/audit conventions.
- Update `docs/sqlite-schema.md` to match the implementation.

## Out of scope

- Discord commands, execution, and scheduling.
- PostgreSQL task storage or analytics replication.
- Permanent deletion of Task or Task Run records.

## Dependencies

- None.

## Acceptance criteria

- [ ] SQLite can create and reopen a Task and its Task Run in an isolated temporary runtime home.
- [ ] Schema migration preserves existing rows and can be applied safely on an existing runtime home.
- [ ] Task and Task Run transitions preserve timestamps, actor audit fields, and soft-deletion rules.
- [ ] Store-level claiming prevents duplicate active runs and rejects invalid transitions.
- [ ] Focused tests cover normal transitions, failures, cancellation, recovery, and duplicate claims.
- [ ] `docs/sqlite-schema.md` documents the new schema.

## Planner Notes

- Use the current SQLite operational store as the source of truth. Do not edit SQLite files directly in tests; use the store and isolated homes.
- The Task owns a Conversation and Agent Session. Reuse existing session/message records where possible.
- Task types are one-time and recurring. Recurrence stores a positive integer interval in hours or days.

## Implementation Plan

1. Inspect schema initialization, migration/version conventions, and SQLite store patterns.
2. Add the smallest Task and Task Run schema and typed store methods.
3. Add isolated tests for migration, state transitions, soft deletion, and run claiming.
4. Update the SQLite schema document and run focused checks.

## Implementation notes

- Keep errors and failure details non-secret. A failed run is never automatically retried by the persistence layer.
- `depends_on` is empty; this is the first task in the feature dependency graph.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
