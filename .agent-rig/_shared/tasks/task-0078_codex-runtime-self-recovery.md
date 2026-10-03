---
id: task-0078
title: Codex runtime self-recovery after timeout or exit
type: bug
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: "Re-review clean: pre-start guard release, bounded reconnect/no replay,
  replacement-server ApprovalRelay rebind, originating-server responses, and
  210-test/typecheck/build/diff acceptance pass."
---







# Task

## Goal

Keep Discord and the queue usable after a Codex timeout or app-server exit.

## Scope

- Treat the active timed-out Turn as uncertain and never replay it automatically.
- Recreate and re-authenticate the Codex app-server with bounded backoff.
- Preserve persisted Agent Session IDs and lazily resume them for later queued Turns.
- Keep later Messages queued while recovery is in progress.
- Fail closed if recovery cannot establish a healthy server.
- Add deterministic fake-server tests for timeout, reconnect, session resume, and no duplicate Turn execution.

## Acceptance Criteria

- [ ] A dead server does not permanently poison the running Discord process.
- [ ] The uncertain Turn remains failed and is not replayed.
- [ ] A later queued Turn resumes after recovery.
- [ ] Recovery failures use fixed non-secret notices/events.
- [ ] Full tests, typecheck, build, and diff checks pass.
