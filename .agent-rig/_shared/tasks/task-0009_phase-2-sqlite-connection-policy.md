---
id: task-0009
title: "Phase 2: SQLite connection policy"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-28
updated_on: 2026-09-28
priority: high
parent: ""
depends_on: []
message: Added guarded node:sqlite opener with WAL and 5s busy timeout; tests,
  typecheck, and build pass.
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---



# Task

## Context
Phase 2 makes SQLite the local durable source of truth before any transport is connected.

## Goal
Open each selected runtime home's `inoai.sqlite` with the required local concurrency policy.

## Scope
- Use Node's built-in `node:sqlite` first; add no SQLite package unless its required API is unavailable.
- Configure WAL journaling and a bounded busy timeout for short core-writer and UI-reader transactions.
- Keep database paths inside the selected runtime home.

## Planner Notes
Dependency gate: this is the sole ready foundation task. Complete it before schema creation.

## Implementation Plan


## Acceptance Criteria

- [ ] A selected runtime home's database opens with WAL and the bounded busy timeout.
- [ ] No connection can target a database outside its selected runtime home.

## Notes
