---
id: task-0062
title: "Phase 6: README Memory Review"
type: doc
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0061
message: README Daily Memory Review section; fixes; re-review clean
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---






# Task

## Context

README says Memory Review execution is deferred.

Sources: Phase 6 in `docs/implementation-phases.md`, the proposal's "Persisted inoai memory" and "Memory review loop" sections, `docs/sqlite-schema.md` (memory_reviews, memories, review notes), ADRs 0002, 0010, `docs/plan-review.md` decision 30, `CONTEXT.md` (Recap, Memory Review, Memory Signal, Manual Memory Entry). Live verification is Claude only; Codex is fake-tested; OpenCode skips reviews.

## Goal

Document Daily Memory Review for owners.

## Scope

- What reviews do, when they run (time, catch-up), that they are silent, per-Session Recaps, Memory Signal rules, manual entries read-only to reviews, and how to inspect results until the Phase 7 UI exists (e.g. `npm start -- memory list`).
- Deleting a review-made Memory needs evidence (an owner Message in range or at least two prior Recaps); unquoted pasted text containing "remember" cannot be distinguished from an owner request.
- Per-runtime support: Claude live-verified and the only runtime that reviews in V1; Codex (review code present but disabled pending an MCP-off check) and OpenCode skip reviews and keep their cursors; data-flow note that reviews send archive text to the runtime's provider.
- Update the status line and V1 bullets.

## Planner Notes

Commands must match the implementation; no secrets or real IDs.

## Implementation Plan

1. Write the section → verify: commands grep-match code; links resolve.

## Acceptance Criteria

- [ ] README accurately describes Memory Review behavior and per-runtime support.
- [ ] Status line reflects Phase 6.

## Notes

- 2026-10-03 worker (claude): Added `## Daily Memory Review` to README.md (before `## Claude runtime`, after the Development/Manual Memory/UI launcher block) with subsections What a review keeps, When it runs, Checking results, Runtime support, Data flow. Updated Status line, the "V1 in brief" review bullet, and the `npm run validate` sentence to name `MEMORY_REVIEW_TIME`/`MEMORY_REVIEW_MAX_CHARS`. Docs-only; claims grep-checked against src/memory-review.ts, src/memory-review-scheduler.ts, src/claude-runtime.ts, src/codex-runtime.ts, src/config.ts, src/index.ts, .env.sample. `git diff --check` clean; ADR 0010 link and #daily-memory-review anchor resolve.
- 2026-10-03 worker (claude) fix: Applied reviewer findings 1–4 in README.md: Status line now says Phases 1–5/5a/5b implemented and Phase 6 code complete with live Claude acceptance pending; agent-reply/one-off wording narrowed; "waiting or being answered"; Claude Behavior settings line scoped to Turns. `git diff --check` clean.
