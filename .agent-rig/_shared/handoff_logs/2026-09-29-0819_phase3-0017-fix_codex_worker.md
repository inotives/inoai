---
agent: worker
role: worker
tool: codex
task: task-0017
task_title: "Phase 3: Discord gateway adapter"
status: handoff
---

# Task 0017 review fixes

Fixed all three lifecycle findings in `src/transport.ts`: a fresh `ShardReady` restores message delivery after reconnect without repeating the first-ready callback; unrecoverable `ShardDisconnect` sets terminal error health and rejects startup if it has not completed; and `stop()` rejects pending startup even if login or the ready callback is still pending. Shutdown no longer overwrites `stopped` with `error` or destroys the client twice through the startup catch path.

Added focused fake-client regressions in `src/test/transport.test.ts` for fresh-ready recovery and resumed delivery, terminal disconnect health, and stop during startup. No Discord connection or credential is used.

Verification: `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` passed. Focused transport suite: 5 passing. Task is back in `review`. No commit or push.
