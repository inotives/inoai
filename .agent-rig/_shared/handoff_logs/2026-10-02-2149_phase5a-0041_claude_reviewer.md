---
agent: reviewer
role: reviewer
tool: claude
task: task-0041
task_title: "Phase 5a: Minimal provider seam"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0041 reviewer handoff

Read: `AGENTS.md`, reviewer role files, task-0041, worker handoff `2026-10-02-2148_phase5a-0041_claude_worker.md`, `docs/implementation-phases.md` Phase 5a, ADRs 0001, 0003, 0007. Reviewed `git diff` of `src/agent-runtime.ts`, `src/codex-runtime.ts`, `src/runtime-turn.ts`, `src/conversation-worker.ts`, `src/index.ts`, and `src/test/`.

## Verdict

Clean. No blocking or task-scoped findings.

## Acceptance criteria

- Shared notices use the runtime's name and login hint. `failureNotice(kind, runtime)` in `src/runtime-turn.ts` produces the same six strings as the old `notices` record when the runtime is Codex (`Codex` / `codex login`), word for word. The worker fallback warning and the startup concurrency log both use `displayName`. A new test pins the exact Codex text and the Claude interpolation.
- There is one `switch (agentProvider)` in `src/index.ts` `run()`, and it selects the runtime, the `ApprovalRelay`, and the probe. Decline logic stays in `ApprovalRelay` and the probe stays in `concurrency-probe.ts`. There is no registry, which matches ADR 0001.
- Codex behavior is unchanged. Construction order is the same (connect, then runtime, then relay). The probe still runs at the same point. A supplied runtime still gets `false`, so it keeps global FIFO, because `probeConcurrency` defaults to `async () => false`. The `"Codex request timed out:"` match is error-text classification, not a notice, so keeping it is correct.
- The `claude` branch throws inside the existing try before `CodexAppServer.connect`, the probe, or `startTransport`/Discord login. The catch calls `instance.release()`. The new transport test confirms there is no login, the lock file is gone, and a restart succeeds.

## Judgment call: Codex-worded legacy approval notices

Agree with keeping `src/index.ts:225` and `src/transport.ts:182` Codex-worded. `approvals` rows only came from the legacy Codex button flow (ADR 0001-fail-closed, ADR 0003). ADR 0007 rules out Claude ever creating them. The notice describes where the saved row came from, not which runtime is running now. In a home switched to `claude`, rewording it would make it factually wrong. The task scope lists "recovery notices", but the only provider-dependent recovery notice is this one, and its provider is fixed. Threading `displayName` into `startTransport` would widen the seam for no correctness gain. Recommendation: keep as is.

## Informational (out of scope; for task-0042)

- `src/database.ts:465` `bindAgentSession` defaults `actor = "runtime:codex"`, and `startAgentSession` does not override it. A Claude home would record `updated_by = runtime:codex` on session binding. That is audit-field accuracy, not a notice, so it belongs to the Claude adapter work.
- `src/agent-session.ts:19` "Agent Session has no Codex thread to resume" and `src/database.ts:467` "Invalid Codex thread ID" are internal error strings. They are not user notices, but task-0042 may want them neutral.

## Checks

- `npm test`: 92 tests, 92 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- Tests use `mkdtemp` runtime homes only. No `.inoai-connect*/.env` was read.

## Next

The planner can mark task-0041 `done` and unblock task-0042.
