---
id: task-0075
title: "Phase 6c: BigQuery export acceptance"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0074
message: "Reviewer approved: 205 tests, typecheck, build, and diff check pass.
  Offline acceptance covers multi-instance identity isolation, disabled no-op,
  redaction, tombstones, retry/reopen idempotency, and local failure handling.
  Residual production scheduler/client wiring flagged for task-0077."
---





# Task

## Goal

Exercise the complete sync path with deterministic fake BigQuery boundaries and no required live cloud account.

## Scope

- Seed two isolated runtime homes with different metadata IDs/names and overlapping source IDs.
- Verify rows remain distinct in the fake BigQuery sink.
- Verify redaction, tombstones, idempotent retries, interval changes, and disabled mode.
- Verify an unavailable sink never prevents normal local operation.
- Run full tests, typecheck, build, and diff checks.

## Acceptance Criteria

- [ ] Two instances export safely into one logical dataset.
- [ ] Disabled/unconfigured sync makes no cloud calls.
- [ ] Failure and restart scenarios preserve local source-of-truth behavior.
- [ ] No Discord live test is required for this analytics-only phase.
