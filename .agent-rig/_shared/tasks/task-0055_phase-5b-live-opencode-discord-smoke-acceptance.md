---
id: task-0055
title: "Phase 5b: Live OpenCode Discord smoke acceptance"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0053
  - task-0054
  - task-0057
message: Live OpenCode Discord smoke a-f pass; review clean; smoke sessions and
  temp deployment removed
---




# Task

## Context

Phase 5b acceptance requires a live Discord smoke test, mirroring task-0048.

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Prove a real OpenCode-backed Agent Instance works end to end in Discord.

## Scope

- Disposable deployment folder with `.inoai-connect-opencode/` whose `.env` the owner supplies (copied by path, never read); Codex and Claude homes stopped if they share the bot token.
- Owner starts a thread, receives an OpenCode answer, continues the same session, triggers one permission-requiring action (fixed notice), exercises `/inoai cancel`, `status`, and `reset`, and confirms the status channel ignores mentions.
- Verify each step in the disposable SQLite; clean up the folder, copied `.env`, and OpenCode sessions created by the smoke afterwards.

## Planner Notes

Requires the owner live in Discord. Never put the token in chat, logs, committed files, or SQLite.

## Implementation Plan

1. Run the checklist with the owner → verify: evidence per step recorded without secrets.

## Acceptance Criteria

- [ ] Start, continue, status, cancel, and reset work against real Discord and OpenCode.
- [ ] A permission-requiring action produces only the fixed notice.
- [ ] Discord matches SQLite; cleanup leaves no copied secrets.

## Notes
