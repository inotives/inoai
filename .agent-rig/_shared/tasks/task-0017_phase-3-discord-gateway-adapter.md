---
id: task-0017
title: "Phase 3: Discord gateway adapter"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-29
updated_on: 2026-09-29
priority: high
parent: ""
depends_on: []
message: Discord gateway adapter reviewed; lifecycle regressions fixed and verified
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---






# Task

## Context
Phase 3 adds the first Chat Transport implementation without invoking an Agent Runtime.

## Goal
Implement the narrow Discord adapter and gateway lifecycle behind the documented transport seam.

## Scope
- Implement start/stop, health state, normalized inbound-message delivery, conversation creation, message sending, and health publishing needed by Phase 3.
- Select Discord only when `CHAT_PROVIDER=discord`; preserve the narrow provider boundary.
- Keep Discord credentials out of logs, SQLite, and test fixtures.
- Make tests deterministic with a fake client; do not contact Discord in automated checks.

## Planner Notes
Dependency gate: this is the sole ready Phase 3 foundation task.

## Implementation Plan


## Acceptance Criteria

- [ ] The adapter maps gateway events into the documented provider-neutral transport shape.
- [ ] Lifecycle state handles initial connection, reconnect, and shutdown without an Agent Runtime.
- [ ] Focused tests run without network access or real Discord credentials.

## Notes
