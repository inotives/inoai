---
agent: reviewer
role: reviewer
tool: codex
task: task-0018
task_title: "Phase 3: Startup health announcement"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0018 re-review: accepted

No findings. The CLI installs signal handlers before transport startup. Its shared shutdown path stops the gateway, waits for startup to settle, closes SQLite, releases the runtime lock, removes handlers, and sets a failing exit code after a terminal gateway disconnect. The first-ready announcement and Event remain one-time per process; a shutdown while the health post is pending creates no online Event.

Verification: `npm test` passed (40 tests), `npm run typecheck`, `npm run build`, and `git diff --check` passed. Additional isolated fake-client checks sent SIGTERM while login was pending and while readiness was pending; both destroyed the client and permitted a fresh `start()` on the same runtime home. Existing tests cover SIGTERM during the health post and terminal disconnect after startup. No live Discord connection was used. No implementation files or task status were changed in this review.
