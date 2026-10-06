---
agent: reviewer
role: reviewer
tool: codex
task: task-0008
task_title: "Phase 1: Setup and local-run documentation"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0008 review handoff

Task 0008 requires documentation corrections.

1. P1 — `README.md:12` says a silent daily Memory Review runs at 06:00. Phase 1 validates its configuration only; scheduled behavior is deferred, and Task 0008 explicitly prohibits documenting scheduler features. Remove or explicitly defer this claim.
2. P2 — `README.md:93-98` gives named-runtime validation/start commands but omits copying and editing `.env.sample` into `.inoai-connect-planner/.env`. In a clean temporary deployment the documented validation exits 1 after creating the blank home. Show the corresponding copy/edit steps or a complete equivalent sequence.

The default runtime-home documentation flow was reproduced successfully in a temporary deployment. `npm test` passes (14 tests) and `npm run typecheck` passes.

## Suggested skills

- `ponytail` for the smallest documentation-only correction.
- `review` after the README is updated.
