---
id: task-0027
title: "Phase 4: Legacy approval restart recovery"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on:
  - task-0026
message: Legacy approval recovery independently reviewed; 59 tests, typecheck,
  build and diff check pass; owner accepted at-most-once notice
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context
V1 declines new approval requests immediately (ADR 0003). Earlier local builds may still have a pending SQLite row or Discord controls; the Phase 4 spike showed CLI `0.157.1` cannot restore that live request after full restart (ADR 0001).

## Goal
Fail any legacy saved pending approvals closed on restart without replaying a turn.

## Scope
- On startup, atomically mark legacy pending approval rows `failed` and redact saved approval previews; make any legacy Discord controls inert and tell the owner to make a fresh request once during normal startup.
- Never answer a lost JSON-RPC request or replay its interrupted turn from SQLite; leave the Conversation/Session mapping available for a new turn.
- Test idempotent repeated startup and inert old controls without a real Discord account. No new 24-hour timer or pending-approval flow is needed in V1.

## Planner Notes
Dependency gate: task-0026 must pass review. `failed` already exists in the approvals schema; avoid a migration unless a concrete missing field is demonstrated. Keep this compatible with the no-new-pending-approvals V1 flow.

## Acceptance Criteria
- [ ] Legacy pending rows become `failed` on restart and old controls cannot approve anything.
- [ ] Restart records one safe recovery Event and, during normal startup, one owner notice. Claim the notice before sending: a crash can omit it, but repeated startup cannot duplicate it or replay a turn.
- [ ] A fresh owner request can use the preserved Session after recovery.

## Notes
