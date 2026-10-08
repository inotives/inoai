---
agent: worker
role: worker
tool: codex
task: task-0112
task_title: "Read docs/agent-profile-and-skills-plan.md — Slice 6: integrated profile and skills verification"
status: handoff
---

# Task 0112 worker fix

## Changes

- Wired selected enabled skill scripts into the ConversationWorker prompt path.
- Revalidated approved package scripts before exposing their provider-facing paths.
- Used the Session project workspace as the script working directory.
- Kept script execution with the configured provider. The harness does not spawn scripts or change provider policy.
- Rejected duplicate top-level `capabilities` mappings in strict skill manifests.

## Tests

- Added a ConversationWorker regression test for a selected Discord-like skill.
- Added skill-loader coverage for prepared script invocations.
- Added manifest coverage for duplicate top-level capability mappings.
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- Focused skill and ConversationWorker tests passed.

Task 0112 is returned to review. No commit or push was made.
