---
id: T-0004
feature: IP-0001
title: Schedule recurring Tasks and recover due work
status: queued
depends_on: [T-0003]
---

# T-0004: Schedule recurring Tasks and recover due work

Feature plan: [IP-0001](../../README.md)

## Context

The app has a one-minute in-process Memory Review scheduler that checks on startup, on a timer, and when chat becomes idle. The external Heartbeat Supervisor is health-only. Recurring Tasks use interval schedules in whole hours or days.

## Goal

Discover and run due recurring Tasks safely through the Task Run service.

## Scope

- Check due recurring Tasks on startup and at the existing one-minute scheduler cadence.
- Schedule the first run one interval after Task creation and later runs one interval after the prior run completes.
- After downtime, run each overdue recurring Task once; do not replay every missed interval.
- Start Tasks only when chat is idle, and run no more than one Task Run at a time per Agent Instance.
- Let a current Task Run finish if chat arrives; process queued chat before another Task Run.
- Keep recurring Tasks active after a failed run, record the failure, and wait until the next interval. Do not retry the failed run automatically.
- Recover an interrupted Task Run after restart as failed without replaying its possible side effects. Schedule a recurring Task's next due time from recovery so the interrupted run is not immediately repeated.
- Keep the external Heartbeat Supervisor's health checks and restart policy unchanged.

## Out of scope

- Calendar schedules, cron syntax, replaying missed occurrences, concurrent runs, and external schedulers.
- Automatic retries after runtime or process failure.

## Dependencies

- [T-0003](../T-0003--task-run-execution/README.md) — manual Task Run service, single-run claim, outcomes, and cancellation.

## Acceptance criteria

- [ ] Recurring Tasks become due on the agreed interval and run at most once for each due occurrence.
- [ ] Startup catch-up runs an overdue Task once and advances its schedule without replaying a backlog.
- [ ] Queued chat blocks new Task Runs and is processed before the next scheduled Task Run.
- [ ] Task Runs stay serial even when multiple Tasks are due.
- [ ] Failed or interrupted recurring runs are recorded and not automatically repeated; the Task remains scheduled for a later interval.
- [ ] Pause, resume, cancellation, and shutdown/restart preserve durable scheduling state.
- [ ] Focused tests cover interval due checks, startup catch-up, idle gating, serial dispatch, and interrupted-run recovery.

## Planner Notes

- Use the selected runtime home's SQLite store for due state. Do not add a new scheduler service or change the external heartbeat.
- A periodic failure does not disable a recurring Task; the owner may manually run it, or wait for the next interval.

## Implementation Plan

1. Inspect the existing Memory Review scheduler's clock, idle gating, startup, and shutdown lifecycle.
2. Add due Task selection and one-minute scheduling with a store-backed claim.
3. Add startup catch-up and interrupted-run recovery.
4. Add deterministic clock-based tests and verify chat/task ordering.

## Implementation notes

- All schedule arithmetic uses elapsed intervals, not local wall-clock time.
- T-0001 through T-0003 provide persistence, Task control, and execution.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
