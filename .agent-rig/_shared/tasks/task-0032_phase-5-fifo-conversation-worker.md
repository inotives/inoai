---
id: task-0032
title: "Phase 5: FIFO conversation worker"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-01
priority: high
parent: ""
depends_on:
  - task-0031
message: Independent re-review clean after shutdown retry fix; 74 tests and full
  checks passed
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---







# Task

## Context

Phase 3 archives eligible inbound Messages; Phase 4 provides Agent Session lifecycle and a safe `runRuntimeTurn` outcome. Task 0031 supplies durable start/recovery and delivery primitives. They are not yet connected by a queue worker.

## Goal

Run each eligible archived user Message as one FIFO Agent Runtime turn with no same-Session overlap or unsafe replay.

## Scope

- Wire Transport, Database, and Agent Runtime through the core startup/shutdown path. Wake the worker on new archived input and startup recovery; avoid a busy polling loop.
- Claim oldest pending work, create/resume the bound Agent Session, mark the durable start boundary before invoking the runtime, and process exactly one turn per Session at a time. Default to global serialization until task-0034 validates concurrency.
- Persist the terminal turn outcome and safe lifecycle Events, including one failure outcome for exhausted safe retries or uncertain post-start execution. Keep the FIFO queue moving after terminal results.
- Handle duplicate gateway delivery, simultaneous inbound Messages, shutdown, and restart without duplicate runtime turns or dropped pending work. Leave prompt-context selection, Discord final delivery, and native controls to later tasks.
- Add deterministic fake-transport/runtime tests using temporary runtime homes, including two Messages in one thread and a crash at the start boundary.

## Planner Notes

Dependency gate: task-0031 must pass independent review. Reuse `startAgentSession`, `resumeAgentSession`, and `runRuntimeTurn`; do not reimplement Codex protocol or weaken its sandbox/approval policy. `runRuntimeTurn` may report an uncertain outcome that must not replay.

## Implementation Plan

1. Wire a minimal worker around existing queue/runtime APIs and prove FIFO with fakes.
2. Exercise duplicate/restart/shutdown boundaries; run typecheck, build, and diff checks.

## Acceptance Criteria

- [ ] Two near-simultaneous owner Messages in one Conversation run FIFO with no overlapping runtime calls; duplicate Discord events do not run twice.
- [ ] A second Conversation waits under the initial global mode without losing its pending Messages.
- [ ] Startup requeues proven pre-start work but never replays uncertain post-start work; the existing Agent Session mapping survives.
- [ ] Each terminal runtime result is persisted once with only safe diagnostic detail, and later queued work can proceed.

## Notes
