---
id: task-0026
title: "Phase 4: Fail-closed Codex approval handling"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on:
  - task-0025
message: Fail-closed Codex approval handling independently reviewed; 57 tests,
  typecheck, build and diff check pass
---




















# Task

## Context
ADR 0003 defers Discord approval buttons in V1. Codex app-server approval is a live server request that must receive a protocol-correct decline without leaking its raw fields.

## Goal
Decline every Codex approval request safely and tell the owner to use local Codex for the blocked action.

## Scope
- Respond to every current CLI `0.157.1` approval method with its protocol-correct decline; never leave a request hanging or auto-approve it.
- Record only a non-secret outcome Event and send one fixed safe notice to the owning Discord thread. Do not persist raw request fields or create a pending approval row.
- Remove the unreachable Discord approval-button/click/preview plumbing and its tests. Leave the approvals table intact for compatibility; task-0027 owns legacy pending-row recovery.
- Keep secrets and raw tool traces out of SQLite, logs, and Discord; no wrapper command allowlist or Codex policy override. Defer Phase 5 queue wiring.

## Planner Notes
Dependency gate: task-0025 passed review. Owner approved this scope change after the 2026-09-30-2021 reviewer handoff. Fix the previously reported leak by removing raw previews entirely, then rerun independent review.

## Acceptance Criteria
- [ ] Command, file, network, permissions, and legacy approval requests all receive protocol-correct declines with no hang or permission elevation.
- [ ] A request containing a token-shaped literal produces only one fixed safe owner notice and non-secret Event; no raw fields, pending row, or actionable buttons appear in SQLite or Discord.
- [ ] Unreachable approval button/click/preview code and tests are removed without affecting ordinary Discord transport behavior.

## Notes

## Blockers

- 2026-09-30: Earlier positive button criteria were superseded by owner-approved fail-closed V1 scope (ADR 0003); task remains gated until planner release.
