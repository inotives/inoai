---
id: task-0077
title: "Phase 6c: Integrated review and acceptance"
type: task
status: done
assigned_to: reviewer
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0071
  - task-0072
  - task-0073
  - task-0074
  - task-0075
  - task-0076
blocked_reason: "Integrated review found production gap: src/index.ts does not
  construct/start BigQuerySyncScheduler, no ADC-backed BigQuery client is
  bundled, so configured settings cannot upload. Offline fake-sink checks pass,
  but Phase 6c configured-instance outcome is not satisfied."
blocked_on: 2026-10-03
message: "Nullable parameter re-review clean: shared typed MERGE builder covers
  nullable STRING/INT64/TIMESTAMP; production/fake paths share it; optional
  non-blocking behavior and secret boundaries remain intact. 207 tests,
  typecheck, build, and diff check pass."
---










# Task

## Goal

Verify Phase 6c against the approved one-way analytics design, SQLite schema, ADR 0012, and all handoffs.

## Scope

- Review the integrated diff and handoffs without implementation edits.
- Confirm optional/non-blocking operation, ADC safety, redaction, instance identity, idempotency, tombstones, and retry behavior.
- Run full tests, typecheck, build, and diff checks.
- Require evidence that unconfigured inoai behaves normally.

## Acceptance Criteria

- [ ] All Phase 6c scenarios are evidenced.
- [ ] Full checks pass.
- [ ] No credentials or raw tool data leave the local boundary.
- [ ] No unresolved findings remain.

## Blockers

- 2026-10-03: Integrated review found production gap: src/index.ts does not construct/start BigQuerySyncScheduler, no ADC-backed BigQuery client is bundled, so configured settings cannot upload. Offline fake-sink checks pass, but Phase 6c configured-instance outcome is not satisfied.
