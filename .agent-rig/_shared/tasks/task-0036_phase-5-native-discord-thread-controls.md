---
id: task-0036
title: "Phase 5: Native Discord thread controls"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0035
message: Independent review clean; 86 tests and full checks passed
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---





# Task

## Context

The owner approved native guild-scoped Discord `/inoai` slash commands, not text prefixed to a bot mention. They operate only in a Conversation's bound thread and must never enter the Codex turn queue. ADR 0004 defines reset as a queue boundary.

## Goal

Provide owner-only status, cancel, and reset controls without creating accidental Agent Runtime turns.

## Scope

- Register native guild-scoped `/inoai status`, `/inoai cancel`, and `/inoai reset` commands using the existing bot token; handle their interaction events and safe acknowledgments. Do not add another API key.
- Resolve the invoking User and bound thread through the same guild/owner/active-Session checks as ordinary input. Reject calls in the report channel, unbound/other-bot threads, or by another User without disclosing private state.
- Status reports the configured project, Session state, queued/running state, and safe delivery/failure summary. Do not reveal credentials, environment values, or raw tool output.
- Cancel stops only the active turn of that Conversation and leaves queued work and the Session usable. Reset cancels the active turn, fails queued Messages without running them, clears the binding, retains archive, and starts a new Agent Session on the next ordinary owner Message. Guard against a late old-turn completion publishing into the reset Session.
- Add deterministic interaction tests for authorization, status, cancel isolation, reset race, and no command-to-Codex queue insertion.

## Planner Notes

Dependency gate: task-0035 must pass independent review. The earlier Phase 3 transport handles `MessageCreate` only; native command registration and `InteractionCreate` handling belong here. Command availability still depends on the bot's guild install permissions, to be verified in task-0037.

## Implementation Plan

1. Add native command registration/interaction routing with narrow owner-thread checks.
2. Exercise control races with fakes and run full checks.

## Acceptance Criteria

- [ ] `/inoai` subcommands appear as native guild commands and require no `@<bot-label>` mention.
- [ ] Non-owner or out-of-scope interactions cannot inspect, cancel, reset, or queue a Codex turn.
- [ ] Cancel affects only its active Conversation; reset fails old queued work, preserves archive, and gives the next Message a fresh binding without leaking old-turn output.

## Notes
