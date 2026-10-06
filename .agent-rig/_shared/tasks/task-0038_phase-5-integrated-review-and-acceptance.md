---
id: task-0038
title: "Phase 5: Integrated review and acceptance"
type: task
status: done
assigned_to: reviewer
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0030
  - task-0031
  - task-0032
  - task-0033
  - task-0034
  - task-0035
  - task-0036
  - task-0037
message: Final integrated review clean; 86 tests, typecheck, build, diff check
  and task reviews pass
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

Independent integrated review of Phase 5 against the amended phase plan, proposal, SQLite schema, ADRs 0002/0004/0005/0006, and worker/reviewer handoffs. Task-0037 supplies real Discord smoke evidence; Phase 8 retains fresh deployment and recovery acceptance.

## Goal

Verify the end-to-end Conversation worker is safe, durable, and faithful to the owner-approved Discord interaction model.

## Scope

- Review the integrated Phase 5 diff and all task handoffs; make no implementation edits. Run focused and full offline tests, typecheck, build, and diff checks.
- Verify owner-only guild-wide mention routing outside the status channel, bot-owned thread continuation, native slash controls, FIFO/no same-Session overlap, concurrency probe/fallback, quote and Memory context, reset/cancel isolation, and durable chunk delivery.
- Inspect restart boundaries for no unsafe Codex replay, no duplicate Discord output after ambiguous send, preserved Session mapping/archive, and safe failure notices. Check that no secrets or raw tool output enter SQLite, logs, Discord, UI data, or committed files.
- Verify that task-0037 actually used real Discord and an authenticated read-only Codex turn where claimed. Record any environmental limitations honestly; do not substitute fake tests for required live evidence.

## Planner Notes

Dependency gate: blocked until every Phase 5 worker task passes independent task-level review. Reviewer writes a handoff with findings/evidence; planner marks this task done only after a clean integrated review and the required live smoke pass.

## Implementation Plan

1. Audit the integrated diff against tasks and design decisions.
2. Run acceptance checks and review live evidence without editing implementation.

## Acceptance Criteria

- [ ] Offline tests, typecheck, build, and diff check pass; all task-level findings are resolved.
- [ ] Required live Discord smoke and isolated Codex concurrency probe have truthful recorded outcomes; global fallback is used unless concurrency was proven.
- [ ] No unauthorized turn, overlapping same-Session run, unsafe replay, duplicate ambiguous delivery, secret leak, or Phase 8 scope creep is found.

## Notes
