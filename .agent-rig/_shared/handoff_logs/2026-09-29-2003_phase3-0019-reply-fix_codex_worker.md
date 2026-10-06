---
agent: worker
role: worker
tool: codex
task: task-0019
task_title: "Phase 3: Inbound Discord eligibility policy"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0019 reply mention fix

Changed the Discord adapter to map `message.mentions.parsedUsers` into the normalized message. Discord's full `mentions.users` collection can include an automatic reply ping, so a plain top-level reply no longer satisfies the explicit bot mention rule. The existing bound-thread policy still ignores mentions; the top-level multi-agent rule now evaluates content mentions.

Updated fake-client fixtures to model parsed content mentions. The top-level ingestion test now first sends a plain reply whose API mention list includes inoai but whose content mention list is empty, verifies that no thread or Session is created, then sends explicit `<@inoai>` requests and verifies normal creation.

Verification: `npm test` (45 passed), `npm run typecheck`, `npm run build`, `git diff --check`, and trailing-whitespace inspection of the touched untracked files all passed. No live Discord or Agent Runtime connection was used. No commit or push.
