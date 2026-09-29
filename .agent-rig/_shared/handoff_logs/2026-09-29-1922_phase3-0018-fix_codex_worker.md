---
agent: worker
role: worker
tool: codex
task: task-0018
task_title: "Phase 3: Startup health announcement"
status: handoff
---

# Task 0018 review fix handoff

The CLI now registers SIGINT/SIGTERM handlers before awaiting Discord startup. One shared shutdown path stops the transport, waits for startup to settle, closes SQLite, releases the runtime lock, removes signal listeners, and clears the keepalive timer. A terminal gateway disconnect invokes that path with a failing process exit code, so a supervisor can restart the app. Reconnects still do not repeat the health announcement.

Added CLI-level fake-client regressions for SIGTERM during an in-flight health post and terminal disconnect after startup. Both verify that the runtime home can be started again; the signal test also confirms no online Event was archived. The existing transport-only tests remain.

Verification: `npm test` (40 passing), `npm run typecheck`, `npm run build`, and `git diff --check` passed. No live Discord credential or connection was used. No commit or push. Task returned to `review`.

Review focus: the single cleanup promise in `run()`, process exit code, and the injected transport path used by the CLI tests. Other uncommitted Phase 3 files were preserved.
