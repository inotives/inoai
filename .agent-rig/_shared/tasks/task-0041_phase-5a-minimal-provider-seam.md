---
id: task-0041
title: "Phase 5a: Minimal provider seam"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0040
message: "Provider seam: displayName/loginHint and one provider switch; review
  clean, 92 tests"
---




# Task

## Context

Shared code hard-codes Codex wording and wiring: `runtime-turn.ts` notices, the worker's concurrency log line, the restart-recovery notice in `index.ts`, and `index.ts` construction of `CodexAppServer`, `CodexRuntime`, `ApprovalRelay`, and `probeCodexConcurrency`.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Make shared notices and startup wiring provider-neutral with the smallest seam, keeping Codex behavior identical.

## Scope

- Each runtime supplies a display name and login hint (Codex: `Codex`, `codex login`) consumed by shared failure, concurrency, and recovery notices.
- Replace the hard-wired construction in `index.ts` with a simple `switch (agentProvider)` that builds the runtime, its approval handling, and its concurrency probe; `claude` may throw a clear not-yet-implemented error until task-0042.
- Keep approval decline and probe logic inside each adapter; no plugin registry (ADR 0001).
- Existing Codex notice text and tests must remain unchanged in meaning.

## Planner Notes

Depends on task-0040 for the provider type. Keep the seam narrow; do not move unrelated Codex internals.

## Implementation Plan

1. Add the display name/login hint and thread them through shared notices → verify: existing runtime-turn and worker tests pass.
2. Introduce the provider switch in `index.ts` → verify: full test suite, typecheck, build.

## Acceptance Criteria

- [ ] Shared user-facing notices are built from the runtime's display name and login hint.
- [ ] `index.ts` selects runtime, approval handling, and probe through one `switch`.
- [ ] Codex behavior and existing tests are unchanged.

## Notes

- 2026-10-02 worker (claude): Added readonly `displayName`/`loginHint` to `AgentRuntime` (Codex: `Codex`/`codex login`). `runtime-turn.ts` failure notices, the worker's concurrency fallback warning, and the startup concurrency log now use them. `run()` selects runtime, approval relay, and probe through one `switch (agentProvider)`; `claude` throws "Claude runtime is not implemented yet" inside the try, so the lock is released. The legacy-approval restart notice stays Codex-worded on purpose, because only Codex ever created approval rows (see handoff). Test fakes gained the two fields mechanically. New tests: exact Codex notice text plus Claude wording, the worker log naming the runtime, and Claude selection failing before Discord login with the lock released. Checks: npm test 92/92, typecheck, build, and diff --check are clean. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-02-2148_phase5a-0041_claude_worker.md`.
