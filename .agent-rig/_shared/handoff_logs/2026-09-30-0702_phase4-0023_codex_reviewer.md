---
agent: reviewer
role: reviewer
tool: codex
task: task-0023
task_title: "Phase 4: Codex app-server foundation and auth"
status: handoff
---

# Task 0023 reviewer handoff

Review outcome: findings; do not mark task done or unlock task 0024 yet.

1. `src/codex-app-server.ts:101-103,113-119`: A `serverRequest/resolved` notification does not remove its `requestId` from `serverRequests`. After the server clears an approval, `respond(id, { decision: "accept" })` still sends an answer instead of rejecting it as no longer live. This conflicts with the exact-live-request approval boundary. Remove the ID on the resolution notification (and add a fake-process regression test for a cleared request).
2. `src/codex-app-server.ts:28,87-96`: A stdin error calls `fail()` and changes state to `error`; `close()` then returns immediately because of that state, leaving a still-running app-server child un-terminated. Ensure an error state does not bypass child termination, with a fake-process regression test.

Both paths were reproduced against the built class using fake stdio: a resolved approval was accepted by `respond()`, and the child received zero `kill()` calls after a stdin error plus `close()`.

Verification: `npm test` (48 passed), `npm run typecheck`, `npm run build`, and `git diff --check` passed. ChatGPT-only `account/read` preflight, API-key environment stripping on the default spawn path, and generic/redacted protocol errors match the task. No live Codex process or developer runtime home was touched. No high-confidence attacker-controlled security vulnerability was identified in this task's current integration surface.

Official protocol reference: https://developers.openai.com/codex/app-server (initialization, `account/read`, approvals, and `serverRequest/resolved`).
