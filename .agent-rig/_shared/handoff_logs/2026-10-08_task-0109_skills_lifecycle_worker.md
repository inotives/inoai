---
agent: worker
role: worker
tool: codex
task: task-0109
task_title: "Read docs/agent-profile-and-skills-plan.md — Slice 3: owner-only local skills.sh installation and lifecycle commands"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-07T22:55:42.941Z
---

# Task 0109 worker handoff

## Result

Implemented owner-only local skill package lifecycle commands for one runtime
home. The implementation does not add provider loading, script execution, or
any Discord command path.

- Added `src/platform/skill-lifecycle.ts`.
- Validates that a package is a real directory with `SKILL.md` and strict
  `skill.yaml`; manifest and deterministic package hash checks run before
  staging.
- Stages packages under the selected runtime home's `skills/<skill-id>/` via a
  temporary directory and rejects symlinks through the existing package hash
  boundary.
- Added CLI commands scoped by `--connect-dir`:
  `skills install --package-dir`, `skills update --package-dir`,
  `skills enable --skill-id --approved-by`, `skills disable --skill-id`, and
  `skills list`.
- Installation never enables a package. Enablement requires an explicit
  approver. Update replaces the package and removes the previous approval, so
  a revision requires reapproval.
- The lifecycle code does not invoke a provider or modify global provider
  configuration. The owner prepares the local package with skills.sh, then
  inoai stages it.
- Added focused lifecycle tests and documented the workflow in `README.md`.

## Verification

- `npm test` — 237 passed, 2 skipped (239 tests)
- `npm run typecheck`
- `npm run build`
- `git diff --check`

No commit or push was performed. Existing phase changes and AgentRig runtime
files remain in the shared worktree.

## Review notes

The skills.sh CLI remains an owner-side preparation step. This slice accepts a
local package directory and keeps installation, enablement, update, and
disable operations out of the agent and Discord runtime paths. Provider-safe
skill discovery and execution remain assigned to later tasks.
