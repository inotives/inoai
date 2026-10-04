---
id: task-0082
title: "Phase 6c: fix PostgreSQL message idempotency constraint"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-05
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0079
message: "Independent review clean: fresh and repeat migration, real Docker
  acceptance, idempotency, lease cleanup, typecheck/build/tests all pass."
---




# Task

## Goal

Make the PostgreSQL message idempotency conflict target match the schema used by `OperationalStore.archiveMessage`.

## Scope

- Add a versioned migration that enforces uniqueness for `(transport, workspace_id, external_message_id)` on non-null external message IDs.
- Keep existing SQLite behavior and BigQuery/Electron boundaries unchanged.
- Add a focused migration/store regression test.

## Acceptance Criteria

- [ ] `archiveMessage` duplicate delivery is idempotent in PostgreSQL.
- [ ] The migration is safe on a fresh database and an already-migrated database.
- [ ] Tests, typecheck, build, and diff checks pass.
