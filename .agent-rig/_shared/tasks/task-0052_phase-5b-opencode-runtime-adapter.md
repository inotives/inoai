---
id: task-0052
title: "Phase 5b: OpenCode runtime adapter"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0050
  - task-0051
message: OpenCode headless adapter with late session-ID rebind, existence check,
  ID validation; re-review clean, 140 tests
---






# Task

## Context

Task-0050 records the verified OpenCode contract. The Claude adapter (`src/claude-runtime.ts`) is the behavioral reference.

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Implement an OpenCode `AgentRuntime` with Claude-adapter-equivalent session, answer, failure, retry, and cancel behavior.

## Scope

- New `src/opencode-runtime.ts` (`displayName: "OpenCode"`, `loginHint: "opencode auth login"`); `connect()` checks `opencode --version` so a missing binary fails startup with the lock released.
- Spawn `opencode run --format json --standalone` per Turn without a shell, cwd = project path, prompt per the spike (stdin preferred), no model/provider flags, never `--auto`/`--yolo`/`--dangerously-skip-permissions`. Make the executable injectable.
- Persona (owner decision D1 after the spike): prepend `agent.md` to every Turn's stdin prompt as a clearly delimited "inoai operating instructions (not a user message)" block, read fresh each Turn. Do not use `OPENCODE_CONFIG_CONTENT` or the experimental instructions API; never write OpenCode config files; do not alter the inherited environment.
- Sessions: the first Turn runs WITHOUT `--session` (a pre-assigned ID triggers the free tier's 403) and stores the streamed `sessionID`; later Turns use `--session <id>`. Pass the prompt on stdin. Before resuming a session not yet seen to succeed in this process (after a restart, or one stored from a failed first Turn), verify it exists and fail closed with `session_missing` (not replay-safe) if it does not — never let `--session` silently create a replacement.
- Answer from completed text events; classify from exit code and `error` events, never from `step_finish`; rate limit → `usage`; auth problems → `authentication`; unknown → `uncertain`; replay-safe `pre_start` ONLY for a spawn failure (ENOENT/EACCES) or an existence-check failure without `SessionNotFoundError`; every other non-zero exit or signal is `uncertain` because OpenCode saves the user message before its first event (ADR 0002). Precedence (per the spike, following `src/claude-runtime.ts`): spawn failure, `timed_out`, `authentication`/`usage` from an `error` event, `cancelled`, `pre_start` (existence check), `uncertain`. Cancel with SIGINT (cancel requested → `cancelled`); 5-minute idle timeout kills the process; `close` stops active children; kill guard skips children without a pid.
- Wire the `opencode` branch of the provider switch (global FIFO). Record session binding actor `runtime:opencode`.
- Deterministic tests with a fake CLI executable; never the real CLI in unit tests. Cover answer (final-step text only; interim tool-step text excluded), resume argv, the persona block prepended on every Turn with the inherited environment unchanged, the existence check running once per process per session (including a session ID stored from a failed first Turn), session_missing, exit 0 with no `error` event and no final-step text (→ `uncertain`), each failure kind, timeout, cancel, never-started retry, lock release, and that no permission-loosening flag appears.

## Planner Notes

Permission-denial notices are task-0053. Do not log or persist raw tool input/output.

## Implementation Plan

1. Implement spawn, parsing, sessions per the spike → verify: fake-CLI tests.
2. Failure mapping, cancel, timeout, wiring → verify: full checks.

## Acceptance Criteria

- [ ] A fake-CLI Turn yields one answer; a follow-up resumes the same session; a vanished session fails with `session_missing`.
- [ ] Failure kinds and replay safety match the Claude adapter; cancel and timeout stop the process safely.
- [ ] No permission-loosening flag, model flag, config write, or raw tool data leak.

## Notes

- 2026-10-03 worker (claude): implemented `src/opencode-runtime.ts`, wired `opencode` in `src/index.ts`, added the provider-neutral `{ type: "session"; id }` RuntimeEvent + `rebindAgentSession` (placeholder `inoai-new:<uuid>` -> streamed `ses_` ID, actor `runtime:opencode`) in `src/agent-runtime.ts`, `src/runtime-turn.ts`, `src/database.ts`. Tests: new `src/test/opencode-runtime.test.ts` (11), `src/test/transport.test.ts` (+1, one updated). 125 -> 137 pass; typecheck, build, diff checks clean. One real two-Turn check (create + restart/resume) passed; session deleted and verified gone. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-03-0153_phase5b-0052_claude_worker.md`.
- 2026-10-03 worker (claude) review fix: L1 a Turn succeeds only with an OpenCode session ID (`src/opencode-runtime.ts:103`), otherwise `uncertain`. L2 accepts only `/^ses_[A-Za-z0-9]+$/` (`:21`). A malformed streamed ID fails closed like a mismatch: child stopped, nothing bound, aliased, or yielded (`:190-195`). A malformed stored ID on resume is orphaned, so the Turn is `session_missing` with no CLI call (`:75`). L4 parity comment added (`:85-86`), with no behavior change. +3 tests in `src/test/opencode-runtime.test.ts` (14 in file). 137 -> 140 pass. Typecheck, build, and diff checks clean. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-03-0202_phase5b-0052-fix_claude_worker.md`.
