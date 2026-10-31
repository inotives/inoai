---
id: BL-0036
title: Post the permission-denial note after the answer
type: idea
status: open
created_at: 2026-10-31T00:48:30Z
source: IP-0006 T-0008 worker handoff 1 and reviewer handoff 1
promoted_to: null
---

# BL-0036: Post the permission-denial note after the answer

## Description

When a Claude or OpenCode Turn has denied tool calls, inoai posts a note through a fire-and-forget notifier before the answer is posted. The note usually lands in Discord before the answer. Post it after the answer, for example with a new `RuntimeEvent` that `runRuntimeTurn` and the Task run executor post after the answer, or a post-answer hook. Also consider an ADR 0007 amendment note that records the completed-Turn note from IP-0006 T-0008.

## Context and evidence

- [T-0008 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0008--completed-turn-denial-note/handoffs/20261031_004741--reviewer-handoff-1.md), Follow-ups.
- `src/inoai/transport/approval-relay.ts` (`permissionDenialNotifier`), `src/inoai/conversation/runtime-turn.ts`, `src/inoai/conversation/task-run-executor.ts`, `src/inoai/agent-runtime/ports.ts`.

## Discussion

None

## Open questions

- None
