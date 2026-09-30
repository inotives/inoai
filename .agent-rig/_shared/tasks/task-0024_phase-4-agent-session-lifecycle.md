---
id: task-0024
title: "Phase 4: Agent Session lifecycle and streaming"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on:
  - task-0023
message: Session lifecycle independently reviewed after streaming/cancellation
  race fixes; 56 tests, typecheck, build pass
---









# Task

## Context
Phase 3 stores a provisional `pending:*` agent session ID; Phase 4 must create and retain the real Codex thread ID without running the Phase 5 queue.

## Goal
Start, resume, cancel, and stream a Codex Agent Session from its configured project path.

## Scope
- Start a persistent Codex thread in the configured project directory, continue it using its stored ID, and replace the provisional SQLite mapping with the real ID.
- Stream progress and final answer through the runtime interface; cancel the active turn without ending the Conversation or corrupting later turns.
- Preserve the runtime home's `agent.md` as the agent personality and the project's own `AGENTS.md` as separate project instructions.
- Add deterministic tests for mapping, stream lifecycle, cancellation, and interrupted process behavior; defer Discord queue/delivery wiring to Phase 5.

## Planner Notes
Dependency gate: task-0023 must pass review. Never resume an interrupted approval by replaying a turn.

## Acceptance Criteria
- [ ] Start persists the real Codex thread ID; continue uses that same ID and project path.
- [ ] Streamed final output is emitted once; cancellation ends the active turn and leaves the Session usable.
- [ ] Process loss does not fabricate completion or silently replay an uncertain turn.

## Notes
