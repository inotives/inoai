---
id: task-0018
title: "Phase 3: Startup health announcement"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-29
updated_on: 2026-09-29
priority: high
parent: ""
depends_on:
  - task-0017
message: Startup health announcement reviewed; shutdown findings fixed and verified
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context
Each app process announces successful Discord readiness once and records that health event durably.

## Goal
Post `inoai is online` exactly once after the process first becomes ready and persist the matching Event.

## Scope
- Publish only to the configured guild/channel after configuration and SQLite startup succeed.
- Suppress duplicate announcements on reconnects within the same process.
- Persist a non-secret startup Event; do not create a Conversation or Message for the health post.

## Planner Notes
Dependency gate: blocked until task-0017 provides the Discord lifecycle and publish operation.

## Implementation Plan


## Acceptance Criteria

- [ ] Initial ready posts one health message and stores one Event.
- [ ] Later ready/reconnect events in the same process post and store no duplicate.
- [ ] Configuration, database, or connection failure never claims the app is online.

## Notes
