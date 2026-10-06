---
id: task-0002
title: "Phase 1: Runtime ignore rules"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-27
updated_on: 2026-09-27
priority: high
parent: ""
depends_on: []
message: "Reviewed: no findings; ignore-pattern acceptance checks pass."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context
Phase 1 requires local runtime and build outputs to stay out of Git.

## Goal
Ignore generated runtime and build artifacts without hiding AgentRig project metadata.

## Scope
- Add ignore rules for `.inoai-connect*/`, `dist/`, and `node_modules/`.
- Preserve the existing `.agent-rig/.creds/`-only policy.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] A local `.inoai-connect/` does not appear in Git status.
- [ ] `dist/` and `node_modules/` do not appear in Git status.
- [ ] Non-credential `.agent-rig/` files remain trackable.

## Notes
