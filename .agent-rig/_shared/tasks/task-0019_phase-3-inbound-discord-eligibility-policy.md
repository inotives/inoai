---
id: task-0019
title: "Phase 3: Inbound Discord eligibility policy"
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
message: Reply-ping mention bypass fixed and independently re-reviewed
---










# Task

## Context
Discord input is untrusted and must pass identity, location, authorship, and mention checks before persistence.

## Goal
Implement deterministic eligibility decisions for top-level and thread Discord messages.

## Scope
- Resolve active Discord Users through the transport-scoped SQLite allowlist.
- Reject bot-authored messages, inactive/unknown users, wrong guilds/channels, and unmentioned top-level messages.
- Require a top-level request to mention this bot and exactly one configured agent bot.
- Treat messages inside a bound thread as eligible without requiring a new mention; do not create bindings here.

## Planner Notes
Dependency gate: blocked until task-0017 supplies normalized Discord events. Tasks 0020 and 0021 consume this policy.

## Implementation Plan


## Acceptance Criteria

- [ ] Only an active allowlisted User in the configured guild/channel can produce eligible input.
- [ ] Bot messages, wrong locations/users, unmentioned top-level messages, another bot's mention, and multi-agent top-level mentions are rejected.
- [ ] Eligibility tests require no Discord or Agent Runtime connection.

## Notes
