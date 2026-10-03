---
id: task-0067
title: "Phase 6b: Codex review runtime boundary"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0066
message: "Review clean: Codex remains fail-closed after unsafe MCP probe; skip
  event and unchanged cursor are covered by tests. Full 190-test suite,
  typecheck, and diff check pass."
---





# Task

## Goal

Make the Phase 6 Codex review path match the verified safety result without weakening the boundary.

## Scope

- Read task-0066's handoff before editing.
- If safe, enable the existing Codex review method with the proven throwaway settings and deterministic failure handling.
- If unsafe or unproven, keep Codex skipped, record a non-secret skip, and preserve the review cursor.
- Never add a bypass, auto-approve, MCP permission, or tool-capability escape hatch.
- Add focused tests for the selected safe/skip path.

## Acceptance Criteria

- [ ] Runtime behavior exactly follows the probe result.
- [ ] Unavailable, unauthenticated, unsafe, and invalid-output cases fail closed without consuming the cursor.
- [ ] No secrets enter prompts, logs, SQLite review output, or Discord.
- [ ] Focused tests and typecheck pass.
