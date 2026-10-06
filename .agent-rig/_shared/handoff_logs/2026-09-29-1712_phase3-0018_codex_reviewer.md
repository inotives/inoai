---
agent: reviewer
role: reviewer
tool: codex
task: task-0018
task_title: "Phase 3: Startup health announcement"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0018 review: changes requested

## Findings

1. **High — terminal Discord disconnect leaves the process alive but unavailable.** `DiscordTransport` sets health to `error` on `ShardDisconnect` (`src/transport.ts:63-67`), but `run()` only observes `startTransport()` during startup and then holds a permanent interval (`src/index.ts:137-152`). If that terminal disconnect occurs after the online Event, the process never exits, the supervisor cannot restart it, and no messages are handled. Wire terminal transport failure to process cleanup/exit; preserve the no-duplicate reconnect behavior.

2. **High — shutdown during initial connection or health post leaves a permanent runtime lock.** `run()` registers `SIGINT`/`SIGTERM` only after awaiting `startTransport()` (`src/index.ts:140-151`). A signal while login, readiness, or the health send is pending takes Node's default exit path, so `instance.release()` never runs. The lock uses exclusive file creation and rejects later starts on `EEXIST` (`src/runtime-home.ts:79-98`), so a supervisor restart remains blocked. Register shutdown handling before the awaited transport startup and ensure cancellation releases the database and lock. The fake-client test at `src/test/transport.test.ts:191-218` calls `transport.stop()` directly, so it does not cover this CLI path.

## Verified

- Initial ready posts one configured-guild/channel health message and archives one non-secret, sessionless `startup_online` Event; reconnect callback does not repeat it in the fake-client tests.
- Config/database failures are ordered before Discord connection. Login/send failures prevent the online Event. No Agent Runtime is invoked.
- Focused transport tests: 9 passed. `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- No live Discord credential or connection was used. No implementation files or task status were changed in this review.
