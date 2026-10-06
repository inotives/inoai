---
agent: worker
role: worker
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0039 fix round 2 (re-review findings A and B)

Inputs: re-review handoff `2026-10-02-2135_phase5a-0039-rereview_claude_reviewer.md`. Edited only `docs/phase-5a-claude-cli-spike.md`, plus a note in the task file.

## Changes

- Finding A (`:94`, `:148`, `:155`): the subscription guard now also refuses when `CLAUDE_CODE_OAUTH_TOKEN` is present in the inherited environment. It checks presence only and never reads, prints, or strips the value. The doc explains why: the `auth status` fields that token produces are unverified. It points to task-0044.
- Finding B (`:52`, `:146`): the effect of `--system-prompt-snapshot off` is now labeled as inferred from `--help` and the binary, not observed (only the default `on` was exercised). Task-0042 verifies it with the real CLI.

## Checks

- `git diff --check`: clean. No trailing whitespace in the untracked spike doc.
- No CLI runs, no `src/` changes, and no new identifiers or secrets added. Redaction is unchanged.
- Task-0039 is set to `review`. Nothing has been committed.

## Next

Reviewer: confirm A and B are resolved, then the planner can mark task-0039 `done`.
