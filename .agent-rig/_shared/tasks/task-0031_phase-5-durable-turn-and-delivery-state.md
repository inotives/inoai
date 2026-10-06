---
id: task-0031
title: "Phase 5: Durable turn and delivery state"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-01
priority: high
parent: ""
depends_on:
  - task-0030
message: Independent re-review clean after reset-race fix; 69 tests and full
  checks passed
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context

Phase 2's SQLite queue requeues every stale `processing` Message because runtime execution was not connected. Phase 5 must distinguish pre-start work from possibly side-effecting runtime work (ADR 0002), and archive final response chunks before Discord send without risking duplicate delivery (ADR 0005).

## Goal

Provide the smallest durable SQLite state and transactional operations needed for safe worker recovery, response delivery, and reset.

## Scope

- Record a durable runtime-start boundary for a claimed inbound Message. Startup may requeue only pre-start work; stale post-start work fails closed with one safe recorded outcome and preserved Agent Session mapping.
- Add transactional operations for response chunks linked to the inbound Message, with locally unique provisional identity before Discord supplies an external ID and explicit pending/confirmed/failed/uncertain delivery state.
- Claim a chunk before sending so ambiguous send completion cannot cause automatic resend after restart. Persist a known failure or confirmed external ID without losing the archived body.
- Add transactional primitives for owner reset to fail still-queued work and discard the live Agent Session binding while retaining archive and audit fields. Do not physically delete persisted records.
- Migrate existing runtime-home databases safely, retaining legacy Messages and approvals. Add focused crash-boundary and migration tests. Do not wire the runtime or Discord send loop here.

## Planner Notes

Dependency gate: task-0030 must pass independent review. Current `messages.external_message_id` is non-null and unique; the migration must support archived pre-send chunks without pretending a provisional ID is a delivered Discord ID. Keep secrets and raw tool output out of all state. The owner prefers no duplicate output over guaranteed Discord delivery.

## Implementation Plan

1. Add minimal schema/transactional operations and exercise them in disposable SQLite homes.
2. Test pre-start versus post-start recovery and all delivery-state transitions; run full checks.

## Acceptance Criteria

- [ ] Restart requeues only work durably known not to have reached the Agent Runtime; uncertain post-start work is failed once, never replayed, and keeps Session mapping.
- [ ] Every final chunk is archived before send and linked to its inbound Message; confirmed, known-failed, and ambiguous delivery remain distinguishable after restart.
- [ ] An ambiguous chunk is never selected for automatic resend, while its full body remains in SQLite.
- [ ] Reset can atomically fail queued work and clear the live binding without deleting archive or audit history.

## Notes
