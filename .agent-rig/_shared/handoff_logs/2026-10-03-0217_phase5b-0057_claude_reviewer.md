---
agent: reviewer
role: reviewer
tool: claude
task: task-0057
task_title: "Phase 5b: Provider-worded authentication and usage notices"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0057 reviewer handoff

Verdict: clean, no findings. I made no implementation edits and did not change the task status. I did not read any `.inoai-connect*/.env` and ran no real CLI.

## Checks against scope

- **Notice texts:** the `failureNotice` templates in `src/runtime-turn.ts` are the same on `main` and HEAD. The working tree changes only the `authentication` case, prefixing it with `authenticationNotice ??` (`src/runtime-turn.ts:14`). Codex (`codex-runtime.ts:9-10`) and Claude (`claude-runtime.ts:29-30`) do not set the field, so their text is byte-identical. Only `OpenCodeRuntime` sets it, to a fixed literal (`src/opencode-runtime.ts:34`). The literal contains no interpolation, runtime output, or secrets.
- **Worker passthrough:** `providerNoticeKinds` is exactly `{authentication, usage, session_missing}` (`src/conversation-worker.ts:16,181`). `uncertain` and `timed_out` still get `uncertainNotice`; `pre_start`, `cancelled`, and the catch path still get `failureNotice`. The fallback triggers are identical to HEAD: the outcome is `uncertain` or `timed_out` (`:177`), or an error is thrown (`:186`).
- **Codex safety:** Codex raises `authentication` and `usage` only from fixed `turn.error.codexErrorInfo` enum codes (`unauthorized`; `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`; `src/codex-runtime.ts:98-100`), never from message text. In any case the notice is built from the kind enum and constant identity fields, so no CLI content can reach Discord. Claude and OpenCode also classify from fixed error-code sets (`claude-runtime.ts:25-26`, `opencode-runtime.ts:25-26`).
- **Seam (ADR 0001):** one optional readonly string on `AgentRuntime`, with no new methods or provider switches. This is the narrowest seam that keeps the other two providers' text unchanged.
- **Tests:** these go through `ConversationWorker` with `FakeTransport` (`src/test/conversation-worker.test.ts:417-481`). They cover 3 providers × {authentication, usage}, asserting the exact sent text, `attempts: 1`, `replay_safe=false`, state `failed`, and that the mode stays `per-session`. A further test checks that `uncertain` falls back to `global` and that `cancelled` gets the generic notice. A `runtime-turn` test checks that the override applies to authentication only. No test lines were removed, and there is no `.skip`, `.only`, or `todo`.
- **Docs:** the Phase 5a scenario (`docs/implementation-phases.md:183`, "Claude-worded notices with the Claude login hint") is now true. The Phase 5b scenario (`:217`) describes the free-tier wording accurately. Phase 4 (`:112`) is consistent. README `:167` (notice to run `claude /login`) is now true. Nothing in the README, proposal, plan-review, or ADRs contradicts these notices.

## Residual note (not a finding)

- When a Claude non-subscription credential is refused, the thread now gets "Run claude /login". The local fix may be to unset an env var instead, but README `:167` already explains that, and the wording is an accepted, pre-existing template.

## Results

- `npm test`: 144 tests, 144 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo. The baseline was 142.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `git diff --check`: clean. The untracked `src/` files are also whitespace-clean.
