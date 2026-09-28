---
agent: reviewer
role: reviewer
tool: codex
task: task-0014
task_title: "Phase 2: Stale-work recovery"
status: done
---

# Task 0014 review: no issues

Reviewed only stale-work recovery against the task and `docs/sqlite-schema.md` worker rules.

- `recoverStaleWork` runs after schema initialization on every database open.
- It uses one immediate transaction and updates only active (`deleted_at IS NULL`) `processing` rows in both `messages` and `memory_reviews` to `pending`.
- It retains the rows and their created/started audit data, records recovery in `updated_by`, and does not touch completed or failed states.
- The restart test covers both record types and preserves original audit data.

Verification: `npm test -- --test-name-pattern='recover|stale|restart'` passed (27 tests); static recovery checks confirmed the transaction, both tables, active-processing predicate, and non-modification of `created_at`/`started_at`.
