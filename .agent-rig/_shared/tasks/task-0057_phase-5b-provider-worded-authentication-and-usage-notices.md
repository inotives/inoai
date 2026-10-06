---
id: task-0057
title: "Phase 5b: Provider-worded authentication and usage notices"
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
message: Provider-worded auth/usage notices for all providers; review clean, 144 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

`src/conversation-worker.ts` posts the runtime's own failure notice only for `session_missing`; authentication and usage failures get the generic notice, so the provider-worded notices built in `src/runtime-turn.ts` from `displayName`/`loginHint` never reach Discord. This predates Phase 5b (Phase 5 posted only generic/uncertain notices; Phase 5a added the `session_missing` passthrough) and contradicts the Phase 5a scenario at `docs/implementation-phases.md` ("Claude-worded notices with the Claude login hint") and the Phase 5b scenario ("OpenCode-worded notices"). Found in the task-0052 review (`.agent-rig/_shared/handoff_logs/2026-10-03-0158_phase5b-0052_claude_reviewer.md`). Owner decision D2: fix now for all three providers.

Sources: Phase 4/5/5a/5b in `docs/implementation-phases.md`, ADR 0002, `src/runtime-turn.ts`, `src/conversation-worker.ts`.

## Goal

Owners see the fixed, secret-free provider-worded notice for authentication and usage failures.

## Scope

- In the conversation worker, post `outcome.notice` for `authentication` and `usage` failures as it already does for `session_missing`; keep the generic notice for every other kind and keep the global-FIFO fallback semantics unchanged.
- Word the OpenCode authentication notice to also cover a free-tier refusal (e.g. "OpenCode could not authenticate with its configured provider, or the free tier refused the request. Check `opencode auth login` locally, then send a fresh request."), via the narrowest change that leaves Codex and Claude notice text byte-identical.
- Tests through the conversation worker (not just `runRuntimeTurn`) for Codex, Claude, and OpenCode authentication and usage failures asserting the exact Discord text, one attempt, and not replay-safe.
- Update any README/test-scenario wording that describes these notices.

## Planner Notes

No secrets or raw CLI output may enter notices. Codex users will now see the specific Codex notice instead of the generic one; this is intended (Phase 4 task 7).

## Implementation Plan

1. Pass through the notices and adjust the OpenCode wording → verify: worker-level tests.
2. Full checks → verify: npm test, typecheck, build, diff checks.

## Acceptance Criteria

- [ ] Authentication and usage failures post the provider-worded fixed notice for all three providers.
- [ ] Other failure kinds and FIFO fallback behavior are unchanged.
- [ ] Codex and Claude notice texts are unchanged; OpenCode's covers the free-tier case.

## Notes

- 2026-10-03 worker: `ConversationWorker` now posts `outcome.notice` for `authentication`, `usage`, and `session_missing` (`providerNoticeKinds`); `uncertain`/`timed_out` keep the uncertain notice and FIFO fallback, `pre_start`/`cancelled` keep the generic notice. Seam: optional `AgentRuntime.authenticationNotice` fixed string, set only by `OpenCodeRuntime`; Codex/Claude templates unchanged vs HEAD. Worker-level tests cover all three providers for both kinds plus `uncertain`/`cancelled`; `runtime-turn` test covers the override. Scenario wording updated in `docs/implementation-phases.md`; README already described the Claude login-hint notice. Tests 142 -> 144, all pass; typecheck, build, diff checks clean.
