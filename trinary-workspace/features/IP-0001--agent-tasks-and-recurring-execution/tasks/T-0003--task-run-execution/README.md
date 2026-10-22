---
id: T-0003
feature: IP-0001
title: Execute manual Task Runs and deliver outputs
status: queued
depends_on: [T-0002]
---

# T-0003: Execute manual Task Runs and deliver outputs

Feature plan: [IP-0001](../../README.md)

## Context

Each Task owns an Agent Session. A Task Run is one runtime iteration. Existing AgentRuntime adapters support persistent sessions and cancellation. The deployment folder is the runtime project path, and the Task thread is the delivery destination.

## Goal

Run one-time Tasks on explicit owner command and deliver each run's completion, failure, cancellation, and requested artifacts to its Task thread.

## Scope

- Add owner-only `run` and `cancel` Task commands.
- Execute exactly one Agent Runtime iteration using the Task goal, the Task Session, and messages since the prior run's cursor.
- Permit one active Task Run per Agent Instance.
- Persist run state before invoking the runtime. Record completion or failure without automatic retry; allow the owner to run a failed one-time Task again.
- On cancellation, stop an active runtime iteration and mark the Task cancelled. Do not expose provider diagnostics or secrets in Discord.
- Give each Task Run a unique output directory at deployment-root `results/<task-id>/<run-id>/` and instruct the runtime to save requested artifacts there.
- Add Discord file-upload support for generated artifacts. Post the run summary and relative paths; if upload fails, keep local artifacts and report their paths.

## Out of scope

- Recurring Task discovery and catch-up.
- Automatic retries or multi-iteration autonomous loops.
- Modifying the selected runtime's sandbox, approval, or credential policy.

## Dependencies

- [T-0002](../T-0002--discord-task-threads/README.md) — Task threads, commands, and persisted steering Messages.

## Acceptance criteria

- [ ] An owner can start a one-time Task manually; creation alone does not start it.
- [ ] A Task Run performs exactly one Agent Runtime iteration and stores its durable result.
- [ ] Multiple active Task Runs cannot overlap within one Agent Instance.
- [ ] Cancellation stops the active runtime and leaves an auditable cancelled state.
- [ ] Failures are reported without automatic retry; manual re-run remains possible for failed one-time Tasks.
- [ ] Requested artifacts are written in a unique run directory under deployment-root `results/` and are not overwritten by later runs.
- [ ] Generated files are uploaded to the Task thread; upload failure leaves the local file and posts its path.
- [ ] Focused tests cover run lifecycle, cancellation, no-retry behavior, output paths, upload success, and upload failure.

## Planner Notes

- Chat queued before a Task Run takes priority. A Task Run already in progress finishes before queued chat is processed; no next Task Run starts until chat is idle again.
- The run prompt includes only Task-thread messages not consumed by a previous run. Messages arriving during a run guide the next run.
- Keep generated files inside the run-specific output directory and preserve runtime provider policy.

## Implementation Plan

1. Inspect runtime session execution/cancellation and Discord message-delivery patterns.
2. Implement the manual Task Run service and single-run claim boundary.
3. Add the run cursor and outcome updates around the runtime iteration.
4. Create unique output directories and deliver generated files to the Task thread.
5. Add focused store, runtime, and transport tests.

## Implementation notes

- The existing runtime adapters are Codex, Claude CLI, and OpenCode. Use the AgentRuntime interface; do not add provider-specific task paths.
- Task and Task Run persistence comes from T-0001; task message routing comes from T-0002.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
