---
id: IP-0001
title: Agent Tasks and Recurring Execution
status: Approved
branch: phase/agent-tasks-and-recurring-tasks
created_at: 2026-10-22T13:11:47Z
---

# IP-0001: Agent Tasks and Recurring Execution

## Goal

Let the owner create and manage durable one-time and recurring Tasks through Discord. Run each Task in its own thread and Agent Session. Save requested file outputs under the deployment folder's `results/` directory and upload a copy to the Task thread.

## Context

The inoai runtime currently processes Discord Conversations, persists their Agent Sessions and Messages in local SQLite, and has no Task feature. The implementation guide defers Tasks and proposes a dedicated Conversation and Agent Session per Task, with messages in the Task thread guiding its next run.

The Heartbeat Supervisor is an external hourly process and SQLite health check. It does not execute application work. The app already has an in-process Memory Review scheduler that checks every minute, waits for chat work to clear, and runs against the selected Agent Runtime. The runtime working directory is the deployment folder (`dirname(runtimeHome.directory)`), while each Agent Instance's SQLite database and configuration remain in its hidden runtime home.

## Scope

- Persist Tasks, Task Runs, recurrence state, and recoverable lifecycle state in the selected Agent Instance's SQLite Operational Database.
- Add owner-only Discord slash commands to create, list, run, pause, resume, and cancel Tasks.
- Create a dedicated Discord thread, Conversation, and Agent Session for each Task. Messages in its thread guide a later Task Run.
- Support one-time Tasks that wait for an explicit run command and recurring Tasks with an interval expressed in whole hours or days.
- Discover recurring Tasks in-process on the existing scheduler cadence. Keep the external Heartbeat Supervisor health-only.
- Run one Agent Runtime iteration per Task Run. Run at most one Task at a time per Agent Instance. Do not start a Task Run while chat work is queued. Let an active Task Run finish before processing newly queued chat; then give chat priority before starting another Task Run.
- Catch up an overdue recurring Task once after startup or downtime. Do not replay every missed interval. Schedule the next interval from Task Run completion.
- Treat a failed or interrupted run as failed and do not retry automatically. Let the owner run it again. A recurring Task remains scheduled for its next interval.
- Let a paused Task's active run finish; prevent later runs until resumed. Cancelling an active Task stops that run and marks the Task cancelled.
- Save requested file deliverables, including Markdown or HTML, under `results/<task-id>/<run-id>/` in the deployment folder. Preserve prior runs' files and upload each produced artifact to the Task thread. If Discord upload fails, retain the local file and report its relative path.
- Preserve the selected runtime provider's existing sandbox and approval policy. Keep Task data and output local to the deployment and runtime home.

## Non-goals

- Cron syntax, calendar-time schedules, replaying each missed occurrence, parallel Task Runs, or autonomous multi-run loops.
- Automatic retry after a failed or interrupted run.
- Remote Task management, family access, another transport, or a separate scheduler service.
- Changing the external Heartbeat Supervisor's health checks or restart policy.
- Uploading arbitrary deployment files that were not produced as a requested Task artifact.

## Proposed design

Use a SQLite-backed Task lifecycle and run history. The in-process scheduler discovers due recurring Tasks at the existing one-minute check and starts one only when chat is idle and no Task Run is active. Use the existing Discord slash-command, thread, Conversation, Agent Session, runtime cancellation, and operational-store patterns where they fit. Generated artifact paths are unique per Task Run. The Task thread receives the run summary, the artifact path, and an uploaded copy of each generated artifact.

The deployment folder is the project working directory; `results/` is a sibling of the hidden `.inoai-connect*` runtime home, not a directory inside that runtime home. The runtime's configured provider policy remains in force.

See [ADR-0001](decisions/ADR-0001-task-lifecycle-and-scheduling.md) for the proposed lifecycle and scheduling trade-offs.

## Human decisions

All decisions below were made on 2026-10-22.

- Use explicit owner-only Discord task commands; keep Task state separate from ordinary chat.
- Discover due recurring Tasks with the in-process scheduler. Keep the external hourly Heartbeat Supervisor health-only.
- Specify recurrence as an interval of whole hours or days.
- After downtime, run each overdue recurring Task once; do not replay missed occurrences.
- Give each Task its own Discord thread and Agent Session. Thread messages guide the next run.
- Run one Agent Runtime iteration per due occurrence.
- Do not start a Task Run while chat is queued. Finish an active Task Run if chat arrives, then process chat before starting another Task Run.
- Allow at most one active Task Run per Agent Instance.
- Give one-time Tasks no automatic start; the owner invokes `run`.
- Do not retry failed or interrupted Task Runs automatically. Owners can invoke `run` again.
- Pause lets an active run finish; cancel stops it and ends the Task.
- Schedule the first recurring run one interval after creation; schedule later runs one interval after completion.
- Keep each run's requested artifacts under a unique `results/<task-id>/<run-id>/` path and preserve prior outputs.
- Post a run summary and relative artifact path in the Task thread and upload a copy of each produced artifact to Discord.
- Allow the owner to create a Task in any accessible guild text channel; create the dedicated Task thread there.
- Human approval: on 2026-10-22 the user approved IP-0001 and directed the project-manager to proceed to task breakdown. The approval resolves the channel-placement question in favor of the recommendation above.

## Repository findings

- `src/inoai/connectors/discord/discord.ts` registers guild-scoped `/inoai` thread controls, creates threads, and sends text messages. Extending it is the transport seam for Task commands and file uploads.
- `src/inoai/memory/memory-review-scheduler.ts` checks every 60 seconds and defers work while chat is busy. It is the in-process scheduling reference.
- `src/inoai/heartbeat/supervisor.ts` owns external hourly process, lock, and SQLite health checks.
- `src/inoai/app.ts` derives the agent project path from the runtime home and wires the Conversation Worker and Memory Review scheduler.
- `src/inoai/persistence/operational-store.ts` and the SQLite connector own durable runtime state. `docs/sqlite-schema.md` defines audit fields, soft deletion, and local SQLite conventions.
- Existing project glossary terms `Task`, `Task Run`, and `Operational Database` are in `CONTEXT.md`. The Task definition now records its one-time/recurring shape and dedicated Conversation and Agent Session.
- No `.codegraph/` index or existing `trinary-workspace/` was present. The initial worktree contains unrelated untracked `.agents/`, `.claude/`, and `skills-lock.json`; they are excluded from this feature.

## Acceptance checks

- SQLite migration, Task and Task Run persistence, state transitions, audit fields, and soft deletion work in isolated temporary runtime homes.
- Owner-only slash commands create, list, run, pause, resume, and cancel Tasks; unauthorized users cannot manage them.
- A Task gets a dedicated Discord thread and Agent Session. Messages in that thread are persisted and included in a later run, never injected into an already-composed run.
- One-time Tasks run only on command. Recurring Tasks run at their interval, execute at most once after downtime, and do not overlap each other.
- Chat queued before dispatch takes priority. Chat arriving during a run is processed after that run and before the next Task Run.
- Pause, resume, cancellation, provider failure, and restart recovery preserve a truthful Task and Task Run state without automatic replay of an interrupted side effect.
- Requested Markdown/HTML deliverables are written under unique deployment-root `results/` run paths. Each file is uploaded to the Task thread; upload failure retains the file and posts its path.
- Focused tests, TypeScript build/typecheck, architecture check, and diff checks pass. Any live Discord check is recorded separately from automated checks.

## Task breakdown

| Task | Scope | Depends on | Status |
| --- | --- | --- | --- |
| [T-0001](tasks/T-0001--sqlite-task-state/README.md) | Persist Tasks and Task Runs in SQLite | None | ready |
| [T-0002](tasks/T-0002--discord-task-threads/README.md) | Create and manage Task threads and Discord controls | T-0001 | queued |
| [T-0003](tasks/T-0003--task-run-execution/README.md) | Execute manual Task Runs, cancel them, and save/upload outputs | T-0002 | queued |
| [T-0004](tasks/T-0004--recurring-task-scheduler/README.md) | Schedule recurring Tasks, catch up once, and honor chat priority | T-0003 | queued |
| [T-0005](tasks/T-0005--task-documentation/README.md) | Document Task commands, lifecycle, and artifact locations | T-0004 | queued |
| [T-0006](tasks/T-0006--integrated-acceptance-review/README.md) | Run final integrated acceptance review | T-0005 | queued |

Dependency order: T-0001 → T-0002 → T-0003 → T-0004 → T-0005 → T-0006. Only T-0001 is ready. The plan is approved; the project-manager will commit the plan and initial task breakdown together before dispatch, subject to the repository's commit authorization rule.

## Final human acceptance

Status: Not started. After all tasks are reviewed and feature acceptance checks pass, the project-manager will present evidence here and wait for the owner's explicit acceptance.
