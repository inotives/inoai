---
id: BL-0009
title: resumeTask mixes database and injected clocks in audit times
type: bug
status: promoted
created_at: 2026-10-23T14:46:00Z
source: IP-0002 T-0002 reviewer handoff 1
promoted_to: IP-0004
---

# BL-0009: resumeTask mixes database and injected clocks in audit times

## Description

`resumeTask` in `src/inoai/connectors/persistence/sqlite/legacy-database.ts` writes `updated_at` with `unixepoch()` in its first UPDATE, then uses the injected `now` in `advanceScheduledTask`. The result is cosmetic, but tests with a fake clock can see mixed audit times.

## Reproduction

- Steps to reproduce: call `resumeTask(taskId, actor, now)` on a scheduled task with a fake `now` far from the wall clock.
- Expected: `updated_at` uses one clock.
- Actual: the first UPDATE writes the wall-clock time; the schedule update writes `now`.

## Context and evidence

- Source: IP-0002 T-0002 reviewer handoff 1 (`trinary-workspace/features/IP-0002--ui-task-management/tasks/T-0002--scheduler-schedules/handoffs/20261023_144500--reviewer-handoff-1.md`, local).

## Discussion

None

## Open questions

None
