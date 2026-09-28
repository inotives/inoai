---
id: task-0013
title: "Phase 2: Session FIFO message worker"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-28
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0011
message: "Reviewer accepted: transactional FIFO claim/finalize, same-session
  exclusion, and global fallback verified."
---




# Task

## Context
One Session may never process two user turns at once; different Sessions are eligible independently after validation.

## Goal
Atomically claim and finalize persisted Message work in documented FIFO order.

## Scope
- Claim the oldest eligible pending user Message transactionally.
- Enforce one processing Message per Session and finalize a response with its inbound Message atomically.
- Permit independent Sessions when concurrency validation passes; otherwise use one global FIFO queue.

## Planner Notes
Dependency gate: blocked until task-0011 supplies Message and Session persistence. Task-0014 depends on this worker state machine.

## Implementation Plan


## Acceptance Criteria

- [ ] Pending Messages are claimed oldest-first with no duplicate claims.
- [ ] Two Messages in one Session cannot both become processing.
- [ ] Different Sessions are eligible independently, with documented global-FIFO fallback if validation fails.

## Notes
