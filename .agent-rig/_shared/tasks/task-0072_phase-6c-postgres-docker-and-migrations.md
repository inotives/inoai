---
id: task-0072
title: "Phase 6c: Docker PostgreSQL and versioned migration runner"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0071
message: "Re-review clean: transaction-scoped advisory lock is acquired
  immediately after BEGIN; focused regression test verifies ordering;
  typecheck/build/focused tests/diff checks pass. Full suite has one unrelated
  stale BigQuery dependency failure; Docker health remains unverified."
---







# Task

## Goal

Provide reproducible local PostgreSQL and explicit privileged migration execution.

## Scope

- Add Docker Compose PostgreSQL for local development and integration tests.
- Add healthcheck, named volume, and non-production development defaults.
- Add numbered plain-SQL migration discovery and execution with `schema_migrations` tracking.
- Ensure migration credentials are supplied only at invocation and never loaded by normal startup.

## Acceptance Criteria

- [ ] `docker compose up -d postgres` starts a healthy local database.
- [ ] `docker compose down` preserves or removes only the documented local volume behavior.
- [ ] Migrations run in order and are idempotent.
- [ ] Normal runtime does not require DDL privileges.
- [ ] Tests, typecheck, build, and diff checks pass.
