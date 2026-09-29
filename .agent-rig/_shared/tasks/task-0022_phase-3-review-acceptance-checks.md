---
id: task-0022
title: "Phase 3: Review acceptance checks"
type: task
status: done
assigned_to: reviewer
created_by: planner
created_on: 2026-09-29
updated_on: 2026-09-29
priority: high
parent: ""
depends_on:
  - task-0017
  - task-0018
  - task-0019
  - task-0020
  - task-0021
blocked_reason: Final review found reply-ping mention bypass; reopen task-0019
  for fix and re-review
blocked_on: 2026-09-29
message: Phase 3 integrated acceptance reviewed; 45 tests and build checks pass
---







# Task

## Context
Independent integrated review of the complete Phase 3 Discord transport behavior.

## Goal
Verify all documented Phase 3 scenarios before Phase 4 starts.

## Scope
- Review the integrated Phase 3 diff against the implementation phase, proposal, security boundaries, and repository standards.
- Run deterministic adapter/routing tests without live Discord credentials or an Agent Runtime.
- Make no implementation edits; report reproducible findings through the reviewer handoff.

## Planner Notes
Dependency gate: blocked until every Phase 3 worker task (0017 through 0021) passes task-level review.

## Implementation Plan


## Acceptance Criteria

- [ ] Startup health posts/persists exactly once per process and not on reconnect.
- [ ] Eligible top-level mentions create separate durable threads/Sessions/Messages.
- [ ] Valid owned-thread messages queue once without a new mention.
- [ ] Wrong users/guilds/channels, bots, unmentioned requests, foreign threads, other-bot mentions, and multi-agent top-level mentions create no work.
- [ ] Cross-agent mentions inside an owned thread stay with its owner, and no Phase 3 path invokes an Agent Runtime.

## Notes

## Blockers

- 2026-09-29: Final review found reply-ping mention bypass; reopen task-0019 for fix and re-review
