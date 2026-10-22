# ADR-0001: Task lifecycle and scheduling

- Status: Accepted
- Date: 2026-10-22
- Feature: [IP-0001](../README.md)

## Context

inoai has persistent Conversations and Agent Sessions but no Task model. The existing external Heartbeat Supervisor checks process health hourly. The app's in-process Memory Review scheduler checks every minute and yields to queued chat. Tasks need durable one-time and recurring work without delaying chat, replaying side effects after downtime, or overwriting prior output files.

## Decision

- Store Task and Task Run lifecycle and scheduling state in the Agent Instance's SQLite Operational Database.
- Give each Task its own Discord thread, Conversation, and Agent Session.
- Make one-time Tasks manual-start. Give recurring Tasks an interval in whole hours or days; first run is due after one interval. Later runs become due one interval after the prior run completes.
- Discover due Tasks in-process. Catch up each overdue recurring Task once after startup, then resume from its next schedule. Keep the external Heartbeat Supervisor health-only.
- Run one runtime iteration at a time. Do not start while chat is queued; do not interrupt an active Task Run for chat. Process queued chat before another Task Run.
- Do not retry failed or interrupted runs automatically. Require an owner command to retry. Pause allows an active run to finish; cancel stops it.
- Write requested artifacts under a unique deployment-root `results/<task-id>/<run-id>/` directory, preserve prior artifacts, upload each to the Task thread, and post its path if upload fails.

## Rationale and consequences

An in-process scheduler can access the selected runtime, database, and Conversation queue. The supervisor remains a process-health boundary. Interval schedules fit the existing minute-level due check and avoid calendar-time and timezone configuration. One catch-up run avoids a backlog of duplicate work. Serial runs and chat priority avoid concurrent edits to the shared deployment folder. Manual retries avoid repeating side effects after partial work. Per-run output directories preserve history and allow the Task thread to link a specific result.

The owner manages Tasks with Discord commands. The owner may create a Task in any accessible guild text channel; inoai creates its dedicated Task thread there.

## Alternatives considered

- Use the external hourly Heartbeat Supervisor for task execution: rejected because it is a separate process-health manager and does not own app runtime work.
- Use cron or local wall-clock schedules: deferred; interval schedules are smaller and have no timezone ambiguity.
- Replay each missed recurrence after downtime: rejected because missed runs can repeat side effects.
- Run Tasks concurrently or preempt them for chat: rejected for this phase because runs can edit the same deployment files and an interrupted write may leave partial output.
- Retry failed runs automatically: rejected because the outcome may include external or file side effects that cannot be proven safe to repeat.
