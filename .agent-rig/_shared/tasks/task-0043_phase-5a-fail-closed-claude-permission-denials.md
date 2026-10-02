---
id: task-0043
title: "Phase 5a: Fail-closed Claude permission denials"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0042
message: "Claude denials fail closed: one notice + count-only Event per Turn;
  review clean, 108 tests"
---




# Task

## Context

ADR 0007 extends ADR 0003 to Claude: every permission prompt fails closed. In `-p` mode the CLI denies prompts it cannot show; the spike records how denials are reported.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Turn each Claude permission denial into the same safe outcome Codex produces.

## Scope

- Detect denials from the CLI's reported denials for the Turn; record one non-secret `approval_unsupported` Event per denial set and post the fixed notice: Claude permission request declined, no action was approved, use local Claude for the blocked action.
- Archive the notice like the Codex relay does; store no tool name arguments, command text, file content, or paths.
- Never add allow rules, `--allowedTools`, `--permission-mode`, or auto-allow read-only tools.
- Fake-CLI tests: denial produces one notice and Event, the Turn still completes or fails per its result, no pending approval row or actionable control, and a token-shaped literal in the denied input appears nowhere in SQLite, logs, or Discord.

## Planner Notes

If the spike shows denials are not observable, this task stays blocked pending owner direction.

## Implementation Plan

1. Implement denial detection and the notice path → verify: fake-CLI denial tests.
2. Run secret-leak assertions → verify: full checks.

## Acceptance Criteria

- [ ] A denied permission prompt yields exactly one fixed notice and one non-secret Event.
- [ ] No approval controls, pending approval rows, or raw tool input are created.
- [ ] inoai passes no permission-changing flag to the CLI.

## Notes

- 2026-10-02 worker (claude): Implemented. Seam: `ClaudeRuntimeOptions.onPermissionDenied(agentSessionId, count)` called at most once per `runTurn` (after the CLI stream ends, before classification) when `max(system/permission_denied events, result.permission_denials.length) > 0`; listener errors are swallowed. `claudePermissionDenialNotifier(database, transport)` in `src/approval-relay.ts` records one `approval_unsupported` Event (actor `runtime:claude`, detail `declined: no safe action preview; denials=<n>`, count only, no tool names) and posts + archives the fixed Claude notice; wired only in the `claude` branch of the provider switch in `src/index.ts`. Codex `ApprovalRelay`, `AgentRuntime`/`RuntimeEvent`, `runtime-turn.ts`, and the worker are unchanged. CLI argv unchanged (no allow/permission-mode flags). Tests: 2 new in `src/test/claude-runtime.test.ts`. npm test 108/108, typecheck, build, diff checks clean.
