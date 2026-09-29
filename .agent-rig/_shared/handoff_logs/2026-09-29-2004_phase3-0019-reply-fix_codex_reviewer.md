---
agent: reviewer
role: reviewer
tool: codex
task: task-0019
task_title: "Phase 3: Inbound Discord eligibility policy"
status: done
---

# Task 0019 reply mention re-review

No findings. `src/transport.ts` now maps `message.mentions.parsedUsers`, which Discord.js derives from message content. A reply ping present only in the API mention list therefore cannot pass the top-level own-bot mention check. Explicit own-bot content mentions still pass; multiple bot content mentions fail the policy. Bound-thread eligibility remains independent of mentions.

The fake-client ingestion regression sends a plain top-level reply with an API bot mention and empty content mentions, then verifies no thread or Session is created. It subsequently verifies explicit top-level mentions create distinct threads. Existing policy and ingestion tests cover multiple agent mentions and unmentioned bound-thread messages.

Verification: focused tests passed; full `npm test` passed (45 tests, 0 failures); `npm run typecheck`, `npm run build`, and `git diff --check` passed. The touched source/test files have no trailing whitespace. No live Discord connection was used. No implementation edits or task status changes were made during review.
