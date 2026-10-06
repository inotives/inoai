---
id: task-0037
title: "Phase 5: Live Discord smoke acceptance"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0036
message: Independent live-smoke review clean; 3 acceptance checks verified;
  later failed turn archived with failure notice, not counted as successful
  answer
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---








# Task

## Context

The owner has supplied a Discord bot token and server settings in a local `.env`, with a status-only report channel. Phase 5 acceptance now requires a focused real Discord smoke test in a separate non-report channel before the broader Phase 8 deployment/recovery tests.

## Goal

Verify the assembled Phase 5 Conversation path against real Discord while keeping credentials and project data isolated.

## Scope

- Prepare a disposable project/runtime home and validate the ignored local configuration without printing token or other secret values. Coordinate with the owner to send real owner-authored test Messages; the bot token cannot impersonate the owner.
- Confirm one online report in the status-only channel; an owner mention there starts no Conversation. In a separate private test channel, confirm an owner top-level bot mention creates one thread and a Codex answer without an OpenAI API key.
- Confirm a second owner Message in the thread continues the same Agent Session, and native status/cancel/reset controls work there without a mention. Check the Discord Messages against SQLite archive and safe Events.
- Use read-only prompts and a disposable project. Record command availability/permissions, observed IDs only where non-secret, results, failures, and any tests blocked by missing owner interaction. Do not log or commit `.env`, token, auth files, or raw tool output.
- Run offline tests, typecheck, build, and diff check after any fixes. Leave fresh deployment, reconnect, crash recovery, and backup acceptance to Phase 8.

## Planner Notes

Dependency gate: task-0036 must pass independent review. The current `.env` key remains `DISCORD_ALLOWED_CHANNEL_ID` until task-0030 changes the parser; the owner must then update only the local ignored file to `DISCORD_STATUS_CHANNEL_ID`. If the owner cannot perform live test Messages, block and hand off the exact missing interaction; do not claim a fake transport is a live pass.

## Implementation Plan

1. Validate safe local setup and request only the owner Messages needed for the smoke checks.
2. Compare Discord/SQLite outcomes, document evidence, and rerun checks for any focused fix.

## Acceptance Criteria

- [x] Real owner-authored mention in a non-report channel creates a thread and receives a read-only Codex answer; the next thread Message continues the same Agent Session.
- [x] Status-only reporting and native owner-only controls behave as specified; the archive records the delivered response and no credentials or raw traces.
- [x] Live-test evidence distinguishes checks actually performed from any blocked checks, and Phase 8's broader acceptance remains explicitly deferred.

## Notes

## Live Evidence

See `.agent-rig/_shared/handoff_logs/2026-10-02-0636_phase5-0037_codex_worker.md` for observed Discord IDs, SQLite state, owner-confirmed ephemeral controls, and offline verification.
