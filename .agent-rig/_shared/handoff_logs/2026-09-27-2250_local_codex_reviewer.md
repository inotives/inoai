---
agent: reviewer
role: reviewer
tool: codex
task: task-0003
task_title: "Phase 1: Runtime home bootstrap"
status: handoff
---

# Task 0003 review handoff

Task 0003 requires revision before approval. `npm test` and `npm run typecheck` pass, but the following defects remain:

1. `src/index.ts:1-2` — `npm start` executes an exports-only module. It neither bootstraps the default runtime home nor acquires its lock, so the core-start acceptance scenarios are not met outside helper unit tests.
2. `src/runtime-home.ts:18-20` — `resolve()` accepts absolute and traversing alternate home paths, allowing a selected runtime home outside the launch/deployment folder. Restrict it to a nonempty direct-child `.inoai-connect*` name.
3. `src/runtime-home.ts:34,38,56` — Node defaults can create the credential-bearing `.env` as world-readable. Create new runtime homes as `0700` and new template/lock files as `0600`, without changing existing files.

Tests should exercise the real startup path and reject traversal/absolute connect-directory inputs. The implementation is currently uncommitted.

## Suggested skills

- `tdd` for focused regression tests before the runtime-home fixes.
- `ponytail` for the smallest startup wiring and validation change.
- `review` after the fixes are ready.
