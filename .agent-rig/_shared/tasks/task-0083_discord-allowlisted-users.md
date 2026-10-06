---
id: task-0083
title: Fix Discord policy for additional active allowlisted users
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-05
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0078
message: "Independent review clean: active family allowlist accepted;
  unknown/disabled rejected; owner-only controls preserved;
  tests/typecheck/build/diff checks pass."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Goal

Allow active users in the PostgreSQL transport allowlist to start and continue Discord conversations; do not hardcode the configured owner as the only eligible user.

## Scope

- Remove the owner-ID equality gate from inbound classification.
- Keep guild, bot-authored, transport, status-channel, mention, and bound-session checks unchanged.
- Preserve owner-only semantics for operations that explicitly require the owner role.
- Add regression coverage for an active `family` user and an unknown user.

## Acceptance Criteria

- [ ] Active allowlisted family users are accepted in the configured guild.
- [ ] Unknown or disabled users remain rejected.
- [ ] Owner-only behavior remains unchanged.
- [ ] Tests, typecheck, build, and diff checks pass.
