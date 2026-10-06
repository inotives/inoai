---
id: task-0042
title: "Phase 5a: Claude runtime adapter"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0039
  - task-0041
message: Claude headless adapter; session_missing fails closed; re-review clean,
  106 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---






# Task

## Context

ADR 0008: one `claude -p --output-format stream-json` process per Turn in the project path. The spike (task-0039) records the verified contract.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Implement a Claude `AgentRuntime` with Codex-equivalent session, streaming, failure, retry, and cancel behavior.

## Scope

- `createSession` assigns a UUID; the first Turn uses `--session-id`, later Turns and restarts use `--resume`. Treat a first Turn that never persisted as new.
- Pass `agent.md` via `--append-system-prompt` with `--system-prompt-snapshot off` on every Turn (so `agent.md` edits reach existing Sessions), pass `--permission-prompts none`, and pass `--model` only when `CLAUDE_MODEL` is set. Leave the owner's settings, MCP servers, skills, `CLAUDE.md`, permission rules, and permission mode untouched.
- Classify each Turn from its final `result` event, not the exit code (SIGINT exits 0). An interrupt without a requested cancel is `uncertain`, not replay-safe. An unknown or unrecognised error signal is `uncertain`.
- Map stream events to `progress` and the final `answer`; map authentication, usage, pre-start, idle timeout (5 minutes without an event), cancellation, and uncertain outcomes to existing `RuntimeFailure` kinds. Only a process that never started is `replaySafe` (ADR 0002).
- `cancel` sends SIGINT and waits for the process to settle; `close` stops active processes.
- Verify once with the real CLI in a disposable temp project that, with `--system-prompt-snapshot off`, a changed `--append-system-prompt` takes effect on `--resume`; record the result in the handoff (spike review finding B). If it does not, stop and report to the planner.
- Spawn without a shell and pass the model as one `--model=<value>` argv element (task-0040 review F1).
- Wire the `claude` branch of the provider switch. Cover runtime-lock release when Claude startup fails (task-0040 review gap).
- Record the session-binding actor as `runtime:claude` for Claude (`bindAgentSession` in `src/database.ts` defaults to `runtime:codex`), and make the internal "Codex thread" errors in `src/agent-session.ts` and `src/database.ts` provider-neutral (task-0041 review notes).
- Add deterministic tests using a fake CLI executable/stream; never invoke the real CLI in unit tests.

## Planner Notes

Permission-denial notices (task-0043), the credential guard (task-0044), and the probe (task-0046) are separate tasks; until task-0046 lands Claude uses global FIFO. Do not log raw tool input or output.

## Implementation Plan

1. Implement process spawning and stream parsing per the spike → verify: fake-CLI tests for answer, progress, resume.
2. Add failure mapping, timeout, and cancel → verify: fake-CLI tests for each failure kind and SIGINT; full checks.

## Acceptance Criteria

- [ ] A fake-CLI Turn yields progress and one final answer; a follow-up resumes the same session ID.
- [ ] Each failure kind maps correctly, and only never-started Turns are retried.
- [ ] Cancel stops the Turn and leaves the session usable; no raw tool trace is logged or persisted.

## Notes

- 2026-10-02 worker: Implemented `src/claude-runtime.ts` (`ClaudeRuntime`, `ClaudeRuntime.connect`) and wired the `claude` provider branch in `src/index.ts`. Session binding actor is now `runtime:<agent_provider>`; "Codex thread" internal errors are provider-neutral. Fake-CLI tests in `src/test/claude-runtime.test.ts`; lock-release test updated in `src/test/transport.test.ts`. Real-CLI check passed: with `--system-prompt-snapshot off`, a changed `--append-system-prompt` (ZEBRA-42 -> QUOKKA-7) took effect on `--resume`, and the resumed Turn recalled the prior answer. Checks: npm test 102/102, typecheck, build, `git diff --check` clean. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-02-2156_phase5a-0042_claude_worker.md`.
- 2026-10-02 worker (review fixes): Removed the unknown-resume `--session-id` fallback (planner decision on F1). A resume whose result reports "No conversation found" now fails as new `RuntimeFailureKind` `session_missing` (not replay-safe, attempted once), classified before the `!started` branch (F2). `runtime-turn.ts` builds the notice "This thread's <displayName> session could not be found. Use /inoai reset to start a new session." and the conversation worker archives that notice for `session_missing` only; Codex never raises it, so Codex behavior and text are unchanged. Cancel is checked before `!started`, so a cancel before init is `cancelled` (F4). The transport test restores an unset `PATH` with `delete` (F5). Added the F3 regression (init seen, then a not-found resume). Intent-to-add index entries removed with `git reset` (F6). Checks: npm test 106/106, typecheck, build, `git diff --check` clean, untracked-file whitespace checks clean. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-02-2204_phase5a-0042-fix_claude_worker.md`.
