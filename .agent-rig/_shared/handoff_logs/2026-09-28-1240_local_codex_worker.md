---
agent: worker
role: worker
tool: codex
task: task-0009
task_title: "Phase 2: SQLite connection policy"
status: done
---

Implemented `src/database.ts` with a dependency-free `node:sqlite` opener.

- It accepts only `<selected-runtime-home>/inoai.sqlite` and rejects symlinked runtime/database paths.
- It configures WAL and a 5,000 ms busy timeout.
- Added focused tests for pragmas and outside-path rejection.

Verification: `npm test` (16 passing), `npm run typecheck`, `npm run build`, and `git diff --check` all pass.

Recommendation: reviewer may now review task-0009; on acceptance, unblock task-0010 (SQLite schema creation).
