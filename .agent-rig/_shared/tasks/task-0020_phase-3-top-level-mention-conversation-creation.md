---
id: task-0020
title: "Phase 3: Top-level mention conversation creation"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-29
updated_on: 2026-09-29
priority: high
parent: ""
depends_on:
  - task-0019
message: Top-level conversation creation reviewed; failure cleanup and shutdown
  drain verified
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context
Each eligible top-level `@inoai` request starts a separate Discord thread and durable Conversation boundary.

## Goal
Create and bind one Discord thread, Session, and initial queued user Message per eligible top-level request.

## Scope
- Create the Discord thread through the transport adapter after task-0019 accepts the request.
- Persist the Session transport/workspace/conversation identifiers and the initiating Message before later runtime work.
- Preserve transport message idempotency; do not invoke Codex or another Agent Runtime.

## Planner Notes
Dependency gate: blocked until task-0019 finalizes inbound eligibility.

## Implementation Plan


## Acceptance Criteria

- [ ] One eligible top-level mention creates one thread, Session, and pending user Message.
- [ ] A second eligible top-level mention creates a distinct thread and Session.
- [ ] Duplicate delivery does not create a second Conversation or Message.

## Notes
