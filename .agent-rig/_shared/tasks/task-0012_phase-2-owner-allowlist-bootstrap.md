---
id: task-0012
title: "Phase 2: Owner allowlist bootstrap"
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
message: Ensured a configured owner change disables other active owners in the
  Discord guild, retained soft-delete reactivation, added regression coverage,
  and verified npm test, typecheck, build, and diff check.
---








# Task

## Context
V1 allows only the configured owner through a transport-scoped SQLite User allowlist.

## Goal
Seed and read the configured owner as the sole active V1 User.

## Scope
- Upsert the configured Discord owner from validated local configuration.
- Preserve one active `owner` User on restart without duplicates.
- Do not add family access, roles, or transport integration.

## Planner Notes
Dependency gate: blocked until task-0011 provides User persistence.

## Implementation Plan


## Acceptance Criteria

- [ ] Bootstrap creates one active owner record.
- [ ] Repeating bootstrap does not duplicate the owner.

## Notes
