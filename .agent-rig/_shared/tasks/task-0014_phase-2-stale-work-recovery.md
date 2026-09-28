---
id: task-0014
title: "Phase 2: Stale-work recovery"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-28
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0013
---




# Task

## Context
An interrupted process must leave durable work recoverable at the next startup.

## Goal
Return stale Message and Memory Review work to a safe pending state at startup.

## Scope
- Recover stale `processing` rows in messages and memory_reviews.
- Preserve audit history and do not delete failed or completed work.
- Do not add a scheduler or multi-process job system.

## Planner Notes
Dependency gate: blocked until task-0013 defines worker state transitions.

## Implementation Plan


## Acceptance Criteria

- [ ] A simulated restart returns stale processing Messages to pending.
- [ ] Recovery preserves rows and their audit history.

## Notes
