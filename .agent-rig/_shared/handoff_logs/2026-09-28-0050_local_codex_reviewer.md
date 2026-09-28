---
agent: reviewer
role: reviewer
tool: codex
task: task-0006
task_title: "Phase 1: Sibling Electron UI launcher"
status: handoff
---

# Task 0006 review handoff

Task 0006 requires one fix.

- P1 — `src/ui.ts:18` invokes macOS `open` without `-n`. macOS reuses an already-running Electron app, so `inoai ui --connect-dir <another-home>` can only activate the existing UI and not open the selected SQLite path. Add `-n` or implement/document a UI second-instance handoff; add a regression that confirms two distinct selected homes each receive their database argument.

The targeted UI test and full suite pass (14 tests), as do typecheck and diff checks, but the current test asserts the incorrect no-`-n` argument vector.

## Suggested skills

- `tdd` for the multi-runtime UI-launch regression.
- `ponytail` for the smallest `open -n` launcher change.
- `review` after the fix is ready.
