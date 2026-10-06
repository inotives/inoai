---
id: task-0028
title: "Phase 4: Runtime failures and safe retry"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on:
  - task-0024
  - task-0027
message: Runtime failure and safe retry independently reviewed after timeout
  fix; 64 tests, typecheck, build and diff check pass
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context
ADR 0002 permits retry only when the turn never started or the runtime proves no side effects; unknown outcomes fail closed.

## Goal
Record safe runtime failures and bound retries without duplicate answers or side effects.

## Scope
- Classify authentication/usage, pre-start transient, timed-out, cancelled, and uncertain post-start failures using only safe non-secret details.
- Record attempts/outcomes as Events; retry proven-safe failures at most three times with bounded backoff.
- On ambiguous post-start failure, do not replay the turn; emit one concise failure notice asking for a fresh request. Publish at most one final answer or failure.
- Keep the Phase 5 queue-worker integration and its stale-`processing` recovery change out of this task, but expose the outcome needed for that later safety gate.

## Planner Notes
Dependency gate: tasks-0024 and 0027 must both pass review. Tests must cover an uncertain failure after a possible side effect.

## Acceptance Criteria
- [ ] Proven-safe pre-start failures retry no more than three times with bounded backoff.
- [ ] Ambiguous post-start timeout/process loss is not retried and is recorded without raw tool traces or secrets.
- [ ] Exhausted safe attempts or an uncertain outcome produces exactly one concise failure notice and no duplicate final answer.

## Notes
