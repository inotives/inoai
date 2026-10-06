---
id: task-0071
title: "Phase 6c: PostgreSQL driver, configuration, and OperationalStore contract"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on: []
message: "Independent review clean. Typecheck/build/focused tests/diff-check
  pass; full suite has only pre-existing BigQuery dependency failure. Reviewer
  handoff:
  .agent-rig/_shared/handoff_logs/2026-10-04-1240_reviewer_0071_codex_reviewer.\
  md"
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Goal

Establish the async PostgreSQL dependency, validated runtime configuration, and narrow `OperationalStore` contract that replaces SQLite access without changing transport behavior yet.

## Scope

- Add the PostgreSQL client and bounded pool configuration.
- Validate `POSTGRES_URL`, `AGENT_INSTANCE_ID`, and optional connection settings without logging secrets.
- Define the async store interfaces needed by conversations, queues, Memory, reviews, events, and Manual Memory.
- Keep BigQuery code isolated and unchanged.
- Add focused unit tests for configuration and store contracts.

## Acceptance Criteria

- [ ] Missing or malformed PostgreSQL configuration fails clearly before runtime work.
- [ ] Connection settings have bounded timeouts and pool limits.
- [ ] No URL, password, or certificate material appears in logs or errors.
- [ ] `AGENT_INSTANCE_ID` accepts the agreed lowercase `agent-` slug format.
- [ ] Tests, typecheck, build, and diff checks pass.
