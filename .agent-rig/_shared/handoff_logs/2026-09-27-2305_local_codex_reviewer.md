---
agent: reviewer
role: reviewer
tool: codex
task: task-0003
task_title: "Phase 1: Runtime home bootstrap"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0003 re-review handoff

Task 0003 still requires revision. Prior default-start, lexical traversal, and permission defects are fixed; `npm test` and `npm run typecheck` pass.

Remaining findings:

1. `src/index.ts:14-15` — the executable calls `start()` without parsing `process.argv`, so the documented `--connect-dir .inoai-connect-2` is ignored and the default home is used. Parse and pass the one supported flag; add an executable-level regression test.
2. `src/runtime-home.ts:32,48-52` — a pre-existing `.inoai-connect*` symlink can point outside the deployment directory. Bootstrap then writes runtime files to that target. Reject a symlinked runtime home (or canonicalize and re-check containment); add a test.
3. `src/runtime-home.ts:68-71` — an old release closure can unlink a successor lock after the original lock is removed and recreated. Make release ownership-aware or use an OS-held lock; add a regression test.

The implementation remains uncommitted.

## Suggested skills

- `tdd` for the three regressions before the fixes.
- `ponytail` for minimal CLI flag parsing and lock ownership handling.
- `review` after the fixes are ready.
