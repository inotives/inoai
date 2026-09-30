---
id: task-0023
title: "Phase 4: Codex app-server foundation and auth"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-30
updated_on: 2026-09-30
priority: high
parent: ""
depends_on: []
message: App-server foundation and ChatGPT auth independently reviewed; 50
  tests, typecheck, build pass
---






# Task

## Context
Phase 4 uses the locally installed Codex app-server and the owner's ChatGPT sign-in, never an OpenAI API key.

## Goal
Establish the narrow Agent Runtime seam, app-server process/protocol lifecycle, and authentication preflight.

## Scope
- Define only the provider-neutral runtime operations Phase 4 needs; implement the Codex app-server connection behind that seam.
- Launch/initialize/close the local app-server safely, correlate JSON-RPC responses and server requests, and handle process exit without leaking pending calls.
- Confirm local `chatgpt` authentication before accepting runtime work; report missing/expired auth without credentials or raw protocol traces.
- Do not use an API key, modify global Codex configuration, or wire the Phase 5 message worker.

## Planner Notes
Sole ready Phase 4 foundation task. Use fake stdio/process fixtures for deterministic tests; any live CLI smoke check must be read-only and opt-in.

## Acceptance Criteria
- [ ] A fake app-server can initialize, answer correlated requests, and shut down; pending calls fail safely on exit.
- [ ] ChatGPT auth passes, while missing/other auth fails before runtime work starts.
- [ ] No OpenAI API key is required or written to logs, SQLite, or test fixtures.

## Notes
