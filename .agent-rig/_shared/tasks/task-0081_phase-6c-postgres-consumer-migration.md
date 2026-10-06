---
id: task-0081
title: "Phase 6c: migrate runtime consumers to the async PostgreSQL store"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-05
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0075
  - task-0076
message: "Independent final review approved: npm test 214/214, focused consumer
  suites 57/57, typecheck, build, and diff checks passed; startup wiring remains
  deferred to task-0078."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---










# Task

## Goal

Move the core runtime consumers from synchronous SQLite calls to the async PostgreSQL `OperationalStore` boundary before startup wiring switches the operational source of truth.

## Scope

- Migrate ConversationWorker, transport/inbound policy, runtime/session helpers, prompt context, Memory Review scheduling, and approval relay consumers.
- Preserve FIFO, idempotency, recovery, redaction, owner-only behavior, and fail-closed delivery semantics.
- Keep Electron SQLite reads and BigQuery paths isolated for their later phases.
- Add focused fake-store and integration-contract coverage for each migrated consumer.

## Acceptance Criteria

- [ ] Core runtime consumers no longer read or write operational SQLite.
- [ ] Consumers use the async store boundary and preserve existing behavior.
- [ ] Electron/UI SQLite access remains isolated and unchanged.
- [ ] Tests, typecheck, build, and diff checks pass.
