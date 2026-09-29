---
agent: reviewer
role: reviewer
tool: codex
task: task-0019
task_title: "Phase 3: Inbound Discord eligibility policy"
status: handoff
---

# Task 0019 review: finding

## Finding

- High: `src/inbound-policy.ts:17-21` admits any active, undeleted User in the guild. An active `family` row created through the exported `upsertUser` function therefore passes top-level and bound-thread classification. The accepted V1 decision in `docs/plan-review.md:22` admits only the configured owner, and `docs/implementation-phases.md:82` explicitly requires rejecting a family member's Discord ID. Gate on the configured owner identity (and owner role), then add a regression case with an active family User for both paths.

## Checks and scope

`npm test` passed (41 tests); `npm run typecheck`, `npm run build`, and `git diff --check` passed. Existing tests cover bot authors, wrong guild/channel, missing or other-bot mention, multi-bot top-level mention, and unbound threads. The thread branch ignores mentions as required, so a cross-agent mention remains with the owning Session. Duplicate delivery is a persistence concern for tasks 0020/0021, not a decision made by this read-only classifier. No live Discord or Agent Runtime connection was used. No implementation files or task status were changed.

Re-review task 0019 after the owner-only gate and regression test; keep downstream tasks blocked until then.
