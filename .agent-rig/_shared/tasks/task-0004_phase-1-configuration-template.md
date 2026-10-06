---
id: task-0004
title: "Phase 1: Configuration template"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-27
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0001
message: Accepted by the human after review
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context
The V1 local configuration shape is defined in the harness proposal.

## Goal
Ship a value-free `.env.sample` that documents every required V1 setting.

## Scope
- Include Discord token, guild, owner, allowed-channel, chat-provider, agent-provider, review-time, and review-max-character settings.
- Use the documented defaults: `discord`, `codex`, `06:00`, and `20000` where applicable.
- Do not include real credentials.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] `.env.sample` lists the exact documented variable names and no secrets.
- [ ] The bootstrap copies a blank local `.env` from the bundled template.

## Notes

## Blockers

- 2026-09-27: Awaiting task-0001 TypeScript project scaffold.
