---
agent: worker
role: worker
tool: codex
task: task-0019
task_title: "Phase 3: Inbound Discord eligibility policy"
status: done
---

# Task 0019 worker fix handoff

Addressed the reviewer finding in `src/inbound-policy.ts`: incoming messages must match the configured owner Discord ID, and that User row must have the active `owner` role. The check applies before both top-level and bound-thread classification.

Added regression cases in `src/test/inbound-policy.test.ts` for an active family User in both paths, plus a configured ID whose row has been changed to `family`.

Verification: `npm test` (41 passing), `npm run typecheck`, `npm run build`, and `git diff --check` all passed. Task returned to `review`; no commit or push.
