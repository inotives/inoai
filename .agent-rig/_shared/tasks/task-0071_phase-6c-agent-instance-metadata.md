---
id: task-0071
title: "Phase 6c: Agent Instance metadata"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: Re-review clean after AGENT_NAME configuration fix; 194 tests,
  typecheck, build, and diff checks pass.
---







# Task

## Goal

Add the local metadata needed to distinguish multiple runtime homes in BigQuery.

## Scope

- Add a singleton `agent_instance_metadata` table to each runtime home's SQLite database.
- Generate and persist a stable UUID once per runtime home.
- Default `agent_name` to the runtime-home folder name and support the agreed non-unique text value.
- Store the configured runtime provider and runtime-home name as non-secret metadata.
- Preserve existing bootstrap, migrations, audit, and soft-delete conventions.
- Do not add BigQuery calls yet.

## Acceptance Criteria

- [ ] Fresh and existing runtime homes get exactly one metadata row.
- [ ] Restarting the same home preserves `agent_instance_id`.
- [ ] Two homes receive different IDs and independent names.
- [ ] No credentials or environment values are stored.
- [ ] Focused tests, typecheck, build, and diff checks pass.
