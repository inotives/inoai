---
id: task-0003
title: "Phase 1: Runtime home bootstrap"
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
message: Accepted by the human after review
---



















# Task

## Context
The deployment folder is the Codex project path; each deployment owns a hidden runtime home.

## Goal
Bootstrap a selected runtime home safely from bundled templates.

## Scope
- Resolve the default `.inoai-connect/` under the launch folder.
- Create a missing home from bundled `.env`, `agent.md`, and SQLite templates.
- Never overwrite an existing runtime home; support an explicitly selected alternate home.
- Provide the minimal runtime-home lock behavior required by the Phase 1 scenarios.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] An empty deployment folder gains `.inoai-connect/` with the required template files.
- [ ] Re-running bootstrap preserves existing runtime-home content.
- [ ] A second core cannot start against a locked home, while an alternate home can initialize independently.
- [ ] Tests use operating-system temporary homes, never the repository-root runtime home.

## Notes

## Blockers

- 2026-09-27: Awaiting task-0001 TypeScript project scaffold.
