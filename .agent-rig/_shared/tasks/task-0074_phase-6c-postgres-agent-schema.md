---
id: task-0074
title: "Phase 6c: per-Agent operational schema and restricted grants"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0073
message: Re-review clean after application-enforced isolation policy fix;
  POSTGRES_ISOLATION_MODE defaults application and unsupported modes fail
  closed. Focused build/typecheck/config tests pass; full test has unrelated
  missing @google-cloud/bigquery dependency.
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Goal

Create the per-Agent Schema tables and grant the shared runtime role only the required DML access.

## Scope

- Translate the operational tables for Sessions, Messages, Memories, Reviews, and Events to PostgreSQL.
- Preserve audit fields, soft deletion, source IDs, and constraints.
- Add indexes for queue claims, session FIFO, review cursors, and updated timestamps.
- Grant `inoai_sync` access only to `inoai_control` and the provisioned Agent Schema.
- Do not grant runtime DDL. Current `POSTGRES_ISOLATION_MODE=application` uses validated Agent Schema selection in the application; `database` mode is reserved and rejected until database-enforced isolation exists.

## Acceptance Criteria

- [ ] Provisioning creates the documented operational tables.
- [ ] Constraints prevent duplicate external messages and multiple active sessions.
- [ ] Runtime role can perform required DML but cannot create, alter, or drop tables.
- [ ] Application operations reject cross-Agent Schema targets; database-enforced isolation is explicitly unsupported and fail-closed.
- [ ] Migration tests pass against Docker PostgreSQL.
