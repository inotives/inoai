---
id: task-0025
title: "Phase 4: Preserve Codex capabilities and policy"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on:
  - task-0024
message: Capability/policy preservation independently reviewed; 56 tests and
  isolated Codex-home smoke pass
---





# Task

## Context
inoai must use the configured local Codex skills, MCP servers, sandbox, and approval policy without adding a wrapper-level allowlist or permission bypass.

## Goal
Prove the session adapter preserves local Codex capabilities and permission boundaries.

## Scope
- Inspect and correct only adapter options that could override local Codex configuration or elevate permissions.
- Exercise a configured local skill or read-only MCP capability with an isolated disposable Codex home, not the developer's global configuration.
- Verify approval-required actions remain approval-required; do not approve them or perform a destructive tool action in acceptance checks.

## Planner Notes
Dependency gate: task-0024 must pass review. Keep this a focused adapter/acceptance task, not a new capability registry.

## Acceptance Criteria
- [ ] The adapter does not disable configured skills/MCP or silently weaken sandbox/approval policy.
- [ ] Isolated tests or a safe smoke check demonstrate configured capability availability.
- [ ] No global Codex config or developer runtime home is changed.

## Notes
