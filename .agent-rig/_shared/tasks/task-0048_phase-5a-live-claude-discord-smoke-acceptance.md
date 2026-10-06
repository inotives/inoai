---
id: task-0048
title: "Phase 5a: Live Claude Discord smoke acceptance"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0043
  - task-0044
  - task-0045
  - task-0046
  - task-0047
message: "Live Claude Discord smoke: start, continue, denial, cancel, status,
  reset, status-channel all pass; review clean"
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

Phase 5a acceptance requires a live Discord smoke test, mirroring task-0037.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Prove a real Claude-backed Agent Instance works end to end in Discord.

## Scope

- Use an isolated `.inoai-connect-claude/` runtime home with its own bot token kept only in its ignored `.env`, a private test channel, and a disposable project with read-only prompts.
- The owner starts a thread, receives a Claude answer, continues the same Agent Session, and exercises `/inoai status`, `cancel`, and `reset`.
- Trigger one permission-requiring action and confirm the fixed decline notice.
- Record the authenticated probe result and confirm Discord Messages match the SQLite archive.

## Planner Notes

Requires the owner to supply the bot and channel locally; never put the token in chat, committed files, logs, or SQLite.

## Implementation Plan

1. Run the smoke checklist with the owner → verify: each step's evidence recorded in the handoff without secrets.

## Acceptance Criteria

- [ ] Start, continue, status, cancel, and reset work against real Discord and Claude.
- [ ] A permission-requiring action produces only the fixed safe notice.
- [ ] Discord Messages match the SQLite archive and no secret is exposed.

## Notes
