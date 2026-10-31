---
id: BL-0032
title: Notice a Task run cancel that arrives while the prompt is built
type: idea
status: open
created_at: 2026-10-30T23:17:37Z
source: IP-0006 T-0002 reviewer handoff 1
promoted_to: null
---

# BL-0032: Notice a Task run cancel that arrives while the prompt is built

## Description

`TaskRunExecutor.execute` checks for cancellation before it builds the prompt. A cancel that arrives during prompt building (now including `listMemories`) is noticed only after `runTurn` starts. This is not a regression; the check order was the same before IP-0006. A second cancel check just before `runTurn` would stop the run earlier.

## Context and evidence

- [T-0002 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0002--memory-in-prompts-and-uses/handoffs/20261030_231737--reviewer-handoff-1.md), Follow-ups.
- `src/inoai/conversation/task-run-executor.ts`.

## Discussion

None

## Open questions

- None
