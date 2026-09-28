---
id: task-0005
title: "Phase 1: Configuration validation"
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
  - task-0004
message: Accepted by the human after review
---







# Task

## Context
Phase 1 validates local configuration before either external provider is contacted.

## Goal
Load and validate a runtime home `.env` with clear, field-specific failures.

## Scope
- Validate required values and supported `CHAT_PROVIDER=discord` and `AGENT_PROVIDER=codex` values.
- Validate `MEMORY_REVIEW_TIME` as local `HH:MM` and `MEMORY_REVIEW_MAX_CHARS` as a valid limit.
- Keep validation offline: no Discord or Codex connection attempts.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] A complete valid `.env` validates successfully without network access.
- [ ] Every missing required setting reports its exact variable name.
- [ ] Unsupported providers fail before startup.

## Notes

## Blockers

- 2026-09-27: Awaiting task-0001 and task-0004 configuration template.
