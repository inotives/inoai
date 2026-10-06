---
id: task-0045
title: "Phase 5a: Provider mismatch and wrong-bot notices"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0041
message: Provider-mismatch refusal and wrong-bot notice; review clean, 115 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

Sessions store `agent_provider`, but the worker resumes without checking it against the configured provider. Each Agent Instance registers its own `/inoai` command, so two bots in one guild show two `/inoai` commands.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Fail closed per thread on a provider mismatch and make wrong-bot command rejections self-explanatory.

## Scope

- Before resuming, compare the Session's `agent_provider` with the configured provider; on mismatch, fail the Message without a runtime call and post a fixed notice naming the thread's provider and offering `/inoai reset` or a new thread.
- Confirm `/inoai reset` then starts a Session with the current provider in the same thread.
- Change the rejection for a `/inoai` interaction in a thread the bot does not own to explain that the thread belongs to another inoai bot.
- Fake transport/runtime tests for both behaviors.

## Planner Notes

Provider-neutral; does not depend on the Claude adapter. Preserve the archive and soft-delete rules.

## Implementation Plan

1. Add the mismatch guard and notice → verify: worker tests.
2. Update the wrong-bot rejection text → verify: transport/control tests; full checks.

## Acceptance Criteria

- [ ] A mismatched Session never reaches the runtime and receives one fixed notice.
- [ ] `/inoai reset` switches the thread to the configured provider.
- [ ] Wrong-bot `/inoai` rejections explain the cause.

## Notes

- 2026-10-02 worker: `ConversationWorker` takes the configured `agentProvider` (4th constructor arg, required). Before start/resume, a mismatched `sessions.agent_provider` fails the Message (`Agent provider mismatch; replay_safe=false`), records `turn_failed` `reason=provider_mismatch; attempts=0`, and archives one fixed notice per Message: "This thread belongs to a Codex session. Use /inoai reset to start a new Claude session here, or start a new thread." Stored name comes from a fixed map (codex/claude); anything else reads "a session from a different agent provider". `ThreadControl.conversationOwnedByBot` (Discord: thread `ownerId` equals the bot user) selects the wrong-bot reply "This thread belongs to another inoai bot. Choose that bot's /inoai command to control it." only after the guild/owner/status-channel checks pass and no active Session matches; other rejections unchanged. Tests: 115/115. Ready for review.
