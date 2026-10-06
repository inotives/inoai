---
id: task-0053
title: "Phase 5b: Fail-closed OpenCode permission denials"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0052
message: OpenCode denials fail closed from stdout-only count; real check
  stdout=stderr=2; review clean, 142 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

OpenCode headless runs auto-reject permission requests; the spike records how a rejection appears. Task-0043 built the Claude notifier (`claudePermissionDenialNotifier` in `src/approval-relay.ts`).

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Turn each OpenCode auto-rejection into the same safe outcome as Claude.

## Scope

- Count rejections per Turn ONLY from stdout `tool_use` events with `state.status:"error"` whose error text starts with "This non-interactive run cannot ask the user for permission". Never count, store, or log stderr lines. Retain no tool names, resources, or input. Verify with a fake CLI and one real check whether each rejection (including `external_directory`) yields its own stdout event.
- At most once per Turn with ≥1 rejection: one `approval_unsupported` Event (`declined: no safe action preview; denials=<n>`, actor `runtime:opencode`) and one archived fixed notice: "OpenCode permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local OpenCode for the blocked action." Reuse or generalize the Claude notifier minimally; Codex relay unchanged.
- The Turn's own outcome is unaffected; listener errors swallowed.
- Tests: multiple rejections → one notice/Event; answer still delivered; no approvals rows or controls; token-shaped literals in rejected input/stderr appear nowhere in SQLite, logs, or sends; a `run()` startup test with a fake `opencode` on PATH proves the wiring.

## Planner Notes

If the spike shows rejections are not observable, block and return to the planner.

## Implementation Plan

1. Implement counting and notifier wiring → verify: fake-CLI tests.
2. Secret-leak and wiring tests → verify: full checks.

## Acceptance Criteria

- [ ] One fixed notice and one count-only Event per Turn with rejections.
- [ ] No raw tool data, approval rows, or controls.
- [ ] Codex and Claude denial behavior unchanged.

## Notes

- 2026-10-03 worker (claude): Implemented. `OpenCodeRuntime` counts stdout `tool_use` events with `state.status:"error"` whose `state.error` starts with the fixed prefix (stderr still discarded, nothing else retained) and calls `onPermissionDenied(session.opencodeId ?? sessionId, count)` at most once per Turn after the stream ends, before classification; listener errors swallowed. The `ses_` ID is passed because `runRuntimeTurn` rebinds SQLite synchronously when the `session` event is yielded, so after a first Turn the placeholder no longer matches the active row. Notifier generalized (`permissionDenialNotifier(provider, name)`) with `claudePermissionDenialNotifier` (byte-identical output) and new `openCodePermissionDenialNotifier`; Codex `ApprovalRelay` unchanged. Wired in the `opencode` branch of `src/index.ts`.
- Real check (1 prompt, OpenCode 2.0.22, fresh mktemp cwd, `run --format json --standalone`, stdin prompt to read `secret.env` and list `/usr/share`): exit 0; 2 stdout `tool_use` events, both `status:"error"` with the fixed prefix (0 other tool errors); 2 stderr auto-rejecting lines (`read`, `external_directory`). stdout count 2 == stderr count 2, so the `external_directory` rejection does produce its own stdout event. Session deleted (exit 0; GET afterwards exit 1); temp dir removed.
- Checks: npm test 142/142 (was 140; 1 existing wiring test updated, 2 new), typecheck, build, `git diff --check`, untracked whitespace checks clean.
