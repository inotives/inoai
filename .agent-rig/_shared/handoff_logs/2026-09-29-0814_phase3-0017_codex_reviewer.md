---
agent: reviewer
role: reviewer
tool: codex
task: task-0017
task_title: "Phase 3: Discord gateway adapter"
status: handoff
---

# Task 0017 review: changes requested

## Findings

1. `src/transport.ts:60-63` — After `ShardReconnecting`, a fresh `ShardReady` event never restores `ready`; the adapter ignores all later `MessageCreate` events. `discord.js` emits `ShardReady` when a shard re-identifies, while `ShardResume` covers only a resumed session. Handle both recovery events while preserving the once-per-process first-ready callback. Reproduced with `ClientReady -> ShardReconnecting -> ShardReady`: `health().state` remains `reconnecting`.
2. `src/transport.ts:59` — `ShardDisconnect` is emitted by the installed `discord.js` only for unrecoverable close codes (`node_modules/discord.js/src/client/websocket/WebSocketManager.js:246-259`). Reporting `reconnecting` indefinitely misstates health; no reconnect is attempted. Treat this event as terminal/error and expose it so the process can exit or be supervised. Add a focused fake-client check.
3. `src/transport.ts:47-50,80-81,87-90` — `stop()` during connection destroys the client but does not settle `firstReady`; `start()` can remain pending forever. Reproduced with a fake `login()` that resolves without `ClientReady`: after `stop()`, health is `stopped` but `start()` remains unsettled. Settle startup when stopped and cover this race.

## Verification

- `npm test`: 32 passing.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- `node --test dist/test/transport.test.js`: 3 passing.
- Reviewed the installed `discord.js` gateway event implementation and ran fake-client reproductions for findings 1 and 3.
- No high-confidence security vulnerability identified in this adapter; the token is passed to `login()` and not logged or persisted here.

Task remains in `review`; planner should return it to the worker for focused fixes and regression coverage before unblocking dependencies.
