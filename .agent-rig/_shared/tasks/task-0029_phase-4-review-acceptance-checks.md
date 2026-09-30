---
id: task-0029
title: "Phase 4: Review acceptance checks"
type: task
status: done
assigned_to: reviewer
created_by: planner
created_on: 2026-09-30
updated_on: 2026-10-01
priority: high
parent: ""
depends_on:
  - task-0023
  - task-0024
  - task-0025
  - task-0026
  - task-0027
  - task-0028
message: Phase 4 integrated acceptance independently reviewed; 64 tests,
  typecheck, build and diff check pass; Phase 8 docs correction verified
---





# Task

## Context
Independent integrated review of Phase 4 against the amended phase contract, ADRs 0001/0002/0003, proposal, and repository safety rules.

## Goal
Verify local ChatGPT-authenticated Codex sessions, fail-closed approvals, recovery, and failure behavior before Phase 5.

## Scope
- Review the integrated Phase 4 diff and worker/reviewer handoffs; make no implementation edits.
- Run focused tests, typecheck, build, diff checks, and safe isolated app-server smoke checks where available.
- Confirm no API-key path, global Codex config mutation, permission bypass, replay of uncertain work, duplicate final answer, or Phase 5 queue-worker creep.

## Planner Notes
Dependency gate: blocked until every Phase 4 worker task passes independent task-level review.

## Acceptance Criteria
- [ ] Local ChatGPT auth, session lifecycle, streaming/cancellation, and configured capability/policy tests pass.
- [ ] Every current approval shape declines safely with one notice and no actionable Discord controls; legacy pending rows fail closed on restart without replay.
- [ ] Only proven-safe turns retry up to three times; uncertain outcomes fail closed with one notice.
- [ ] No secrets or raw tool traces enter SQLite, logs, Discord, or committed files.

## Notes
