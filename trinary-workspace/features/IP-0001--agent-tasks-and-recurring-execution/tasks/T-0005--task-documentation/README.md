---
id: T-0005
feature: IP-0001
title: Document Task commands and operations
status: queued
depends_on: [T-0004]
---

# T-0005: Document Task commands and operations

Feature plan: [IP-0001](../../README.md)

## Context

The README documents runtime setup, Discord controls, and deployment folders. It does not describe Tasks or generated Task artifacts.

## Goal

Document how the owner creates and operates one-time and recurring Tasks, including where results are saved.

## Scope

- Document Task command options and examples for create, list, run, pause, resume, and cancel.
- Explain one-time and recurring behavior, interval timing, startup catch-up, run failures, retries, and chat priority.
- Document Task threads and how messages guide a later run.
- Document unique output directories under deployment-root `results/` and Discord file delivery/fallback.
- Update `docs/implementation-phases.md` to remove or replace the deferred Task direction with the delivered behavior.
- Keep deployment and SQLite documentation consistent with the implemented schema and output path.

## Out of scope

- New behavior or interface changes beyond IP-0001.
- Changes to unrelated deployment, Memory Review, or Heartbeat documentation.

## Dependencies

- [T-0004](../T-0004--recurring-task-scheduler/README.md) — complete Task lifecycle and recurring behavior.

## Acceptance criteria

- [ ] README instructions match the implemented command syntax and owner-only scope.
- [ ] Docs accurately describe Task lifecycle, timing, failure recovery, and task-thread message behavior.
- [ ] The `results/` deployment path, unique per-run outputs, Discord upload, and upload fallback are clear.
- [ ] The deferred Task direction is removed or replaced with delivered status.
- [ ] Documentation links are valid and `git diff --check` passes.

## Planner Notes

- Use short direct sentences and preserve the project's local-only and provider-policy boundaries.
- Do not claim a live Discord test unless it is actually run and recorded.

## Implementation Plan

1. Inspect affected README sections and the deferred phase entry.
2. Update only Task-related user and deployment documentation.
3. Verify command examples against implementation and check links/diff.

## Implementation notes

- Do not add documentation for deferred features or capabilities not in the accepted plan.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
