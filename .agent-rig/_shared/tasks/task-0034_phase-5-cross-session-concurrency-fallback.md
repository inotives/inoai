---
id: task-0034
title: "Phase 5: Cross-session concurrency fallback"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-01
priority: high
parent: ""
depends_on:
  - task-0033
message: Independent re-review clean; real probe unavailable, global FIFO
  retained; 78 tests and full checks passed
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---









# Task

## Context

The accepted plan permits parallel turns in different Conversations only after a real Codex two-session concurrency check. Until then, task-0032's worker stays globally serialized; same-Session overlap is never allowed.

## Goal

Enable per-Session concurrency only when proven safe, with automatic global fallback that preserves queued work.

## Scope

- Add a controlled switch from global FIFO to per-Session work after an authenticated, read-only two-session Codex app-server probe in an isolated temporary project using the owner's existing local sign-in. Do not alter global Codex configuration or use a Discord token for the probe.
- If the check fails, cannot be completed, or runtime behavior later becomes unreliable, keep or return to global serialization without dropping, duplicating, or concurrently running a Session's queued Messages.
- Use deterministic fake-runtime tests to cover overlap between different Sessions, no overlap within one Session, fallback while work is queued, and restart defaulting to safe global mode.
- Record the probe result and whether real cross-Session concurrency was enabled in the worker handoff. Do not claim a fake test proves app-server concurrency.

## Planner Notes

Dependency gate: task-0033 must pass independent review. An unsuccessful real probe is an acceptable global-fallback result, not permission to assume parallelism. Do not require an OpenAI API key or consume a Discord bot token.

## Implementation Plan

1. Add the minimal scheduler mode transition and fake-runtime race checks.
2. Run the isolated real probe, record evidence, and verify fallback behavior.

## Acceptance Criteria

- [ ] Different Conversations overlap only after a passing authenticated two-session probe; a single Conversation never overlaps its turns.
- [ ] Failed, unavailable, or later-unreliable concurrency retains a working global FIFO queue with no dropped or duplicated Messages.
- [ ] Probe uses only disposable files and read-only prompts, preserves local Codex policy, and reports the actual result without overstating it.

## Notes
