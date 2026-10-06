---
id: task-0073
title: "Phase 6c: shared control schema and Agent Instance provisioning factory"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0072
message: "Independent review clean: control schema, slug/schema derivation,
  deterministic credential-free provisioning SQL, focused tests,
  build/typecheck/diff checks passed. Full suite has only pre-existing missing
  @google-cloud/bigquery failure."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---





# Task

## Goal

Create the shared `inoai_control` schema and a reviewable factory that emits DBeaver-ready SQL for new Agent Instances.

## Scope

- Add control tables for schema migrations, Agent Instance registration, and ownership metadata.
- Validate and normalize lowercase `agent-...` IDs.
- Derive safe underscore-form Agent Schema names without interpolating raw text.
- Generate a deterministic SQL script for the current planner and future Agent Instances.
- Register `agent_name`, provider, runtime-home name, and schema identity without secrets.

## Acceptance Criteria

- [ ] Provisioning output is deterministic and reviewable before execution.
- [ ] Duplicate normalized IDs are rejected.
- [ ] Unsafe identifiers cannot become SQL identifiers.
- [ ] Factory output contains no credentials.
- [ ] Tests cover current planner provisioning and a future agent slug.
