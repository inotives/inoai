---
agent: reviewer
role: reviewer
tool: codex
task: task-0078
task_title: Codex runtime self-recovery after timeout or exit
status: blocked
---

## Findings

1. **High — active Session guard can remain permanently locked when the app-server dies before `turn/start` returns.**
   In `CodexRuntime.runTurn`, `this.active.set(sessionId, active)` is set immediately after creating the `started` request, but the cleanup only deletes the guard when `settled` is true or a failure is observed while `this.server.health()` is not ready. If the `turn/start` request rejects before a turn ID is returned (the normal `CodexAppServer` failure/exit path), `failure` is still undefined and `turnId` is undefined, so the `finally` block leaves `active` populated. The next queued turn calls `resumeSession` and fails with `Agent Session has an active turn`, so the recovery goal is not met for this failure timing. Add a deterministic fake-server test for failure before the turn ID and clear the guard for that dead-server outcome without replaying the uncertain request.

2. **High — approval handling is not rebound to a replacement server.**
   `src/index.ts` creates one `ApprovalRelay` for the initial `CodexAppServer`, while the reconnect factory swaps `CodexRuntime.server` to a newly connected server. `ApprovalRelay` registers its request listener only on the original server and has no rebind path. After recovery, a Codex approval request on the replacement server is therefore not declined or archived with the fixed safe notice; it can remain unanswered. Preserve the existing fail-closed approval boundary by either making the relay follow the active server or routing replacement-server requests through the same decline handler, with a deterministic test.

## Verification

- `npm test` — 208 passing
- `npm run typecheck` — passed
- `npm run build` — passed via `npm test`
- `git diff --check` — passed

The existing timeout/reconnect test proves the happy path only; it does not cover the pre-`turn/start` failure or replacement-server approval path above.
