---
id: task-0011
title: "Phase 2: Archived record persistence"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-28
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0010
message: "Fixed memory review cursor monotonicity: completed ranges use a
  high-water cursor, reject new stale ranges, and regression coverage passes."
---








# Task

## Context
Sessions, Messages, Events, Memory, and Memory Reviews become durable before Discord or Codex integration.

## Goal
Implement the focused SQLite reads and writes needed for v1 archival records.

## Scope
- Implement Session, Message, Event, Memory, and Memory Review persistence.
- Apply uniform actor/timestamp fields and exclude soft-deleted rows from ordinary reads.
- Enforce transport/workspace/message idempotency and Memory Review source cursors.

## Planner Notes
Dependency gate: blocked until task-0010 creates the schema. Tasks 0012, 0013, and 0015 consume this persistence layer.

## Implementation Plan


## Acceptance Criteria

- [ ] Records survive a database reopen and carry all audit fields.
- [ ] Soft-deleted rows are excluded from normal reads without physical deletion.
- [ ] Re-delivering one transport/workspace/message ID stores one Message.
- [ ] Memory Review selection returns only Messages newer than the last completed review.

## Notes
