---
id: task-0076
title: "Phase 6c: PostgreSQL Memory, review, events, and Manual Memory CLI"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0075
blocked_reason: "Final re-review: remove unrelated deferred
  @google-cloud/bigquery dependency from package.json and package-lock.json;
  rerun full checks."
blocked_on: 2026-10-04
message: "Final re-review clean: BigQuery dependency removed; prior Memory
  Review fixes remain intact; npm test 210 passing, typecheck, build, and diff
  check pass."
---











# Task

## Goal

Move Memory, Memory Review, event, and Manual Memory management operations to PostgreSQL.

## Scope

- Port Memory ranking inputs, soft deletion, provenance, and review cursor operations.
- Port review scheduling state and atomic review commits.
- Port non-secret events and failure recovery.
- Update the Manual Memory CLI to use the OperationalStore.
- Preserve secret redaction and review fail-closed behavior.

## Acceptance Criteria

- [ ] Memory and review tests pass against fake and Docker-backed stores.
- [ ] Review cursors remain monotonic and transactional.
- [ ] Manual Memory create/list/delete never invokes the Agent Runtime.
- [ ] Soft deletion and audit fields remain intact.
- [ ] No raw tool output or credentials are persisted.

## Blockers

- 2026-10-04: Re-review: add store-level REPEATABLE READ and advisory-lock race regressions; full npm test is blocked by missing @google-cloud/bigquery dependency.
- 2026-10-04: Final re-review: remove unrelated deferred @google-cloud/bigquery dependency from package.json and package-lock.json; rerun full checks.
