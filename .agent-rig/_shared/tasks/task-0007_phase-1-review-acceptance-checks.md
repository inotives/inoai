---
id: task-0007
title: "Phase 1: Review acceptance checks"
type: task
status: done
assigned_to: reviewer
created_by: planner
created_on: 2026-09-27
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0001
  - task-0002
  - task-0003
  - task-0004
  - task-0005
  - task-0006
  - task-0008
message: "Final Phase 1 acceptance review passed: no findings."
---





# Task

## Context
Independent review for the complete Phase 1 scaffolding outcome.

## Goal
Verify Phase 1 behavior and regressions against the approved documentation before Phase 2 starts.

## Scope
- Review only Phase 1 changes and its documented acceptance scenarios.
- Run the project build/test commands and add no feature changes.
- Report findings with reproducible evidence; do not approve secrets or ignored runtime data.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] A complete valid `.env` validates without Discord or Codex contact, and each missing required variable is named.
- [ ] Bootstrap creates a missing temporary runtime home without overwriting an existing one.
- [ ] Locking one home blocks a second core while an explicit alternate home starts independently.
- [ ] Unsupported providers fail before startup.
- [ ] `inoai ui` targets the sibling bundle and does not mutate runtime-home data.
- [ ] Tests use temporary runtime homes; `.inoai-connect*/`, `dist/`, and `node_modules/` remain absent from Git status.

## Notes

## Blockers

- 2026-09-27: Awaiting completion of all Phase 1 worker tasks.
