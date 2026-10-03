---
agent: reviewer
role: reviewer
tool: codex
task: task-0071
task_title: "Phase 6c: Agent Instance metadata"
status: done
---

## Re-review

The worker fix addresses the prior finding. `AGENT_NAME` is now an optional normal-startup configuration value, trimmed and rejected when it contains control characters or exceeds 100 characters. Blank values remain absent from the parsed configuration, so metadata bootstrap defaults to the runtime-home folder basename. Startup passes the configured name and provider to metadata bootstrap.

The metadata table remains a singleton per runtime-home SQLite database (`id = 1`). Fresh homes receive a UUID and independent names; reopening without overrides preserves the UUID and persisted values. Metadata contains only non-secret identity/provider/home fields, with audit and soft-delete columns. No BigQuery or credential handling was added in this task.

## Verification

- `npm test` — 194 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

## Disposition

Clean. Task may be marked done and task-0072 may be selected next.
