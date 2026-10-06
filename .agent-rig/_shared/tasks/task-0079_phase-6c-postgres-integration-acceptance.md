---
id: task-0079
title: "Phase 6c: PostgreSQL Docker integration and acceptance"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0078
message: "Independent final re-review clean: both stores are explicitly closed
  before tracking is cleared; admin-side lease release is verified separately;
  shared runtime pool shutdown is verified by an expected post-close query
  failure; runtime role/DML/DDL checks remain; integration skips safely without
  URL. npm test, typecheck, build, diff-check pass; Docker-backed positive run
  unavailable because no Docker daemon."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---








# Task

## Goal

Prove the PostgreSQL operational path end to end in the local Docker environment.

## Scope

- Add opt-in integration tests for migrations, provisioning, grants, leases, queue claims, Memory, reviews, and shutdown.
- Exercise two Agent Instances concurrently in separate schemas.
- Verify restart/recovery and unavailable-database behavior.
- Document DBeaver provisioning, Docker startup, runtime configuration, and the disposable SQLite boundary.
- Keep credentials and test secrets out of committed files and logs.

## Acceptance Criteria

- [ ] `npm test` remains dependency-free from Docker.
- [ ] Opt-in PostgreSQL integration checks pass with Docker Compose.
- [ ] Two Agent Instances do not collide in schemas or leases.
- [ ] PostgreSQL outage fails safely without fabricated replies.
- [ ] Documentation matches the implemented cutover.
