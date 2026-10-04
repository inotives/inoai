---
agent: worker_0081
role: worker
tool: codex
task: task-0081
task_title: "Phase 6c: migrate runtime consumers to the async PostgreSQL store"
status: handoff
---

## Changes

- Added `src/test/sqlite-store.ts`, a test-only async `OperationalStore` fixture backed by isolated SQLite test homes. It is not imported by production runtime modules.
- Converted operational consumer tests to use the async fixture for ConversationWorker, inbound policy, prompt context, runtime-turn/session helpers, approval relay, provider notifiers, and Memory Review scheduler.
- Awaited async prompt/classification calls in affected tests.
- Added missing async store methods needed by the scheduler fixture.

## Verification

- `npx tsc --noEmit` passes.
- `npm run build` passes as part of `npm test`.
- `npm test` still fails because `src/index.ts:start()` now eagerly connects to the configured PostgreSQL URL; existing startup/transport tests intentionally use `example.test` and need dependency-injected stores or a dedicated test startup path. Several scheduler assertions also need async timing updates.
- No commit or push made.
