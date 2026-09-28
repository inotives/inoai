---
agent: worker
role: worker
tool: codex
task: task-0015
task_title: "Phase 2: Manual Memory management CLI"
status: done
---

# Manual Memory CLI complete

Added `inoai memory add <text>`, `inoai memory list`, and `inoai memory delete <id>` with optional `--connect-dir`. They operate directly on the selected runtime home's SQLite database, create entries with `origin = manual`, attach the active owner when present, and never call the Agent Runtime startup path.

Added focused temporary-runtime tests for creation, owner provenance, active listing, durable soft deletion, absence from normal listings, and executable subcommands using a blank configuration. README now documents the commands.

Verified with `npm run typecheck`, `npm test` (29 passing), `npm run build`, and `git diff --check`.
