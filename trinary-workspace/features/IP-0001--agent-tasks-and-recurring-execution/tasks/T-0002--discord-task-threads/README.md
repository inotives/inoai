---
id: T-0002
feature: IP-0001
title: Create and manage Discord Task threads
status: queued
depends_on: [T-0001]
---

# T-0002: Create and manage Discord Task threads

Feature plan: [IP-0001](../../README.md)

## Context

The Discord adapter registers owner controls for bot-owned threads, can create a thread from a starter message, and sends text messages. Task creation is allowed in any accessible guild text channel and creates a dedicated thread and Agent Session.

## Goal

Add owner-only Discord commands to create and inspect Tasks, and connect each Task thread to its persisted Conversation and Session.

## Scope

- Extend guild-scoped `/inoai` commands with Task creation, listing, pause, and resume operations.
- Allow the owner to create a Task in the current accessible guild text channel; post a starter message and create its dedicated thread there.
- Create and persist the Task's Conversation/Agent Session association and return the thread link to the command caller.
- Persist owner messages in a Task thread as steering input for a later Task Run. Do not process them as independent Conversation Turns.
- Keep Task management owner-only and ignore bot-authored messages.
- Make the list response show Task type, state, next run when applicable, and Task thread.

## Out of scope

- Manual Task Run execution and cancellation.
- Recurrence polling.
- Discord file uploads.

## Dependencies

- [T-0001](../T-0001--sqlite-task-state/README.md) — Task and Task Run persistence.

## Acceptance criteria

- [ ] Owner-only create/list/pause/resume commands work in accessible guild text channels and Task threads.
- [ ] Creating a Task creates a persisted Task, a dedicated thread, and its Conversation/Agent Session association.
- [ ] Unauthorized or non-guild command attempts fail closed without creating state.
- [ ] Messages in a Task thread are persisted for a future run and never start normal Conversation Turns.
- [ ] Task controls reply safely, without allowing mentions or exposing secrets.
- [ ] Focused tests cover authorization, thread creation failure, and message routing.

## Planner Notes

- Preserve current `/inoai status`, `/inoai cancel`, and `/inoai reset` behavior for ordinary Conversations.
- Task threads are distinct from user Conversations for turn processing, even though they reuse existing Message and Session storage.

## Implementation Plan

1. Inspect the Discord transport, command authorization, Conversation creation, and inbound Message routing.
2. Add Task command payloads and owner authorization through existing patterns.
3. Create the starter message and Task thread, then persist its association.
4. Route Task-thread messages to persisted steering context rather than the normal Conversation worker.
5. Add focused adapter and application tests.

## Implementation notes

- Keep Discord as the only transport in scope. Do not add CLI or SPA Task management.
- This task depends on T-0001 and is initially queued.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
