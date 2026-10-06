---
id: task-0021
title: "Phase 3: Bound-thread message ingestion"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-29
updated_on: 2026-09-29
priority: high
parent: ""
depends_on:
  - task-0020
message: Bound-thread ingestion independently reviewed and verified
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---





# Task

## Context
Only threads created and bound by this Agent Instance continue its Conversation.

## Goal
Archive eligible ordinary messages from owned Discord threads as pending user turns.

## Scope
- Resolve the bound Session by Discord thread and accept allowlisted human messages without a new mention.
- Ignore messages in another bot's thread and every bot-authored message.
- Keep a cross-agent mention inside an owned thread as ordinary content for the owning Session; never create a handoff or second Session.
- Persist the reply reference and Message only; do not invoke an Agent Runtime.

## Planner Notes
Dependency gate: blocked until task-0020 establishes durable thread bindings.

## Implementation Plan


## Acceptance Criteria

- [ ] An allowlisted human message in an owned thread queues exactly one pending user Message.
- [ ] Other threads and bot-authored messages queue nothing.
- [ ] A cross-agent mention in an owned thread remains one turn for the owning Session.

## Notes
