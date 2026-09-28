---
id: task-0006
title: "Phase 1: Sibling Electron UI launcher"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-27
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0001
  - task-0003
message: Accepted by the human after review
---










# Task

## Context
The UI is a sibling macOS Electron bundle, never runtime-home data.

## Goal
Expose `inoai ui` to start the sibling Electron bundle for the selected runtime home.

## Scope
- Locate and launch the sibling UI bundle from the deployment folder.
- Pass only the selected runtime-home SQLite location as needed by the UI contract.
- Do not place UI binaries or generated UI files inside `.inoai-connect/`.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] `inoai ui` targets the sibling UI bundle.
- [ ] Launching it leaves the selected runtime-home data unchanged.

## Notes

## Blockers

- 2026-09-27: Awaiting task-0001 and task-0003 runtime-home bootstrap.
