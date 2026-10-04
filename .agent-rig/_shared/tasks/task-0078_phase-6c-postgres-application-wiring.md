---
id: task-0078
title: "Phase 6c: wire PostgreSQL into startup and remove SQLite runtime path"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0076
  - task-0077
  - task-0081
message: "Re-review clean after explicit test-fixture migration: PostgreSQL-only
  production startup, lease lifecycle, no compatibility database field,
  sanitized errors, 213 passing and 1 explicit legacy SQLite skip;
  typecheck/build/diff clean."
---










# Task

## Goal

Make PostgreSQL the only operational database for normal inoai startup.

## Scope

- Wire configuration, pool, OperationalStore, provisioning identity, and lease acquisition into startup/shutdown.
- Remove SQLite reads/writes from the core runtime and Manual Memory CLI.
- Keep the Electron UI and BigQuery paths isolated for their later phases.
- Fail clearly when PostgreSQL is unavailable or the Agent Schema is unprovisioned.
- Update runtime configuration and security documentation.

## Acceptance Criteria

- [ ] Normal startup requires PostgreSQL and an owned Agent Instance lease.
- [ ] Discord, conversation worker, Memory Review, and Manual Memory use PostgreSQL.
- [ ] No operational SQLite file is created or consulted by startup.
- [ ] BigQuery behavior is unchanged and not required.
- [ ] Tests, typecheck, build, and diff checks pass.
