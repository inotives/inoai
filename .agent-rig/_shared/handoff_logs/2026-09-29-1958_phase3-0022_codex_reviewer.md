---
agent: reviewer
role: reviewer
tool: codex
task: task-0022
task_title: "Phase 3: Review acceptance checks"
status: handoff
---

# Phase 3 integrated acceptance review

## Finding

1. **Medium — A plain top-level reply can create a Conversation without an explicit bot mention.** `src/transport.ts:76-87` builds `mentionedBotUserIds` from `message.mentions.users`, then `src/inbound-policy.ts:25-28` accepts the message if that collection contains only the current bot. In discord.js, `mentions.users` reflects the API mention list and can include a reply ping; its `parsedUsers` collection is specifically limited to mentions in the message content (`node_modules/discord.js/src/structures/MessageMentions.js:88-103,226-240`). A configured owner replying to an inoai bot post in the allowed channel with body `Just checking` and no `<@inoai>` is therefore classified as `top-level` and creates a thread/Session/Message. This violates the Phase 3 requirement to ignore unmentioned top-level messages. A deterministic smoke check against the built `classifyIncomingMessage` returned `top-level` for that exact body with a bot reply mention and `replyToExternalMessageId`; the body contained no explicit mention. Use content-only parsed mentions for the top-level decision and add a regression at the adapter/ingestion boundary for a reply ping without a text mention. Keep bound-thread messages independent of mentions.

## Verification

- `npm test`: 45 passed, 0 failed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed; untracked Phase 3 source/test files had no trailing whitespace.
- Reviewed the current diff against `main`, the Phase 3 task files, proposal, implementation phases, SQLite schema, domain context, plan review, and task-level worker/reviewer handoffs.
- Deterministic fake-client tests cover one online post/Event per process, reconnect, distinct top-level threads, duplicate delivery, owner and location exclusions, bound-thread queueing, cross-agent mentions, failure cleanup, and shutdown drain. No live Discord credentials or Agent Runtime were used.

The earlier task-0020 review noted the external limitation that a failed Discord thread deletion can leave an unbound remote thread after a database failure; that limitation remains. No implementation edits or task status changes were made in this review.
