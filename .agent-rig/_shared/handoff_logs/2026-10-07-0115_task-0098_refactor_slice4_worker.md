---
agent: worker
role: worker
tool: codex
task: task-0098
task_title: "Read docs/source-structure-refactor-plan.md — Slice 4: isolate runtime and transport adapters"
status: handoff
---

## Summary

- Moved the provider-neutral runtime seam and Codex, Claude, OpenCode, and
  Codex app-server adapters into `src/runtime/`.
- Moved the Discord transport, inbound message policy, and fail-closed approval
  relay into `src/transport/`.
- Moved the runtime concurrency probes into `src/runtime/`.
- Updated the application composition root and conversation/memory production
  imports to use explicit capability paths.
- Retained small root compatibility entry points for existing imports and
  tests; no public symbol or CLI/provider/Discord behavior was removed.
- Updated the README source layout to document the runtime and transport
  boundaries.

## Verification

- `npm test` — passed: 222 tests, 2 expected skips.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Scope and risk

The implementation is structural only. Provider command construction, auth and
permission policy, runtime failure classification, concurrency probes, Discord
message filtering, thread/control routing, health publishing, delivery errors,
and approval notices remain unchanged. The working tree also contains the
cumulative changes from earlier refactor slices and AgentRig SQLite sidecars;
these were not staged or committed by this worker.

## Review request

Please review the moved module relative imports, explicit compatibility entry
points, and capability import direction. Confirm that the existing runtime and
transport test suites still exercise the moved implementations and that no
behavioral changes or unrelated files were introduced.
