---
agent: worker
role: worker
tool: codex
task: task-0020
task_title: "Phase 3: Top-level mention conversation creation"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0020 review fix

Discord threads created for a request are now deleted if the SQLite Session/Message transaction fails. The existing in-flight guard remains active through cleanup, so a redelivery after successful cleanup can create one bound thread. The Discord adapter exposes thread deletion for this compensation.

Accepted inbound work is tracked on the running instance. Shutdown stops accepting new requests, waits for pending ingestion, then stops Discord and closes SQLite. Direct instance release also drains pending work before closing the database.

Focused fake-client regressions force a Session insert failure after thread creation, then redeliver the request; they also hold thread creation open across SIGTERM and verify the Session and Message survive restart. `npm test` passed (44 tests), `npm run typecheck`, `npm run build`, and `git diff --check` passed.

Changed files: `src/index.ts`, `src/transport.ts`, and `src/test/transport.test.ts`. No commit or push. If Discord's delete API itself fails, cleanup logs the failure; that external failure cannot guarantee removal of the remote thread.
