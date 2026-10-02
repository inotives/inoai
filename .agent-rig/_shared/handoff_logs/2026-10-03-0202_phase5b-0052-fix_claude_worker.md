---
agent: worker
role: worker
tool: claude
task: task-0052
task_title: "Phase 5b: OpenCode runtime adapter"
status: handoff
---

# task-0052 worker fix handoff (L1, L2, L4 comment)

Inputs: the reviewer handoff `2026-10-03-0158_phase5b-0052_claude_reviewer.md` and the planner's decision on L4. L3 was handled in the docs by the planner. Only `src/opencode-runtime.ts` and `src/test/opencode-runtime.test.ts` changed. Codex and Claude behavior is unchanged. I ran no real CLI and read no `.env`, OpenCode config, DB, or credentials. Nothing is staged or committed.

## Fixes

**L1** (`src/opencode-runtime.ts:103`)
- The success condition now also requires `session.opencodeId`.
- An answer whose stream never carried a `sessionID` falls through to `uncertain`, which is not replay-safe.

**L2** (`:21`, `:75`, `:190-195`)
- `openCodeSessionId = /^ses_[A-Za-z0-9]+$/`.
- A streamed `sessionID` that fails the pattern sets `mismatched` and stops the child with SIGINT.
  - The event is skipped, and so are later events.
  - Nothing is assigned to `opencodeId`, aliased in `sessions`, or yielded as `{type:"session"}`.
  - Existing state is left alone, and the Turn ends `uncertain`.
- On resume, any ID that fails the pattern is marked `orphaned`, so the Turn is `session_missing` with no CLI or API call.
  - This includes the old `inoai-new:` keys. The check was previously a prefix test and is now the pattern.
  - `opencodeId` is set only for valid IDs, so a bad ID can never reach `--session` (`:159`) or `/api/session/<id>` (`:131`).

**L4** (`:85-86`)
- Added a comment explaining that a first Turn which never streamed a session ID starts fresh in-process, matching the Claude adapter's in-process "new" state, and is orphaned after a restart.
- No behavior change.

## New tests (`src/test/opencode-runtime.test.ts`)

1. **Events without `sessionID` on two Turns.**
   - Each Turn yields no events and fails `uncertain` (not replay-safe).
   - Both runs used plain `baseArgv`, and both children are dead.
2. **Malformed streamed ID, for each of `--x`, `../x`, and `""`.**
   - On a new session: no events and `uncertain`. The next in-process Turn starts fresh (no `--session`) and binds the valid fake ID.
   - On a resumed `known` session: `uncertain`, and the next Turn still uses `--session known`.
   - Resuming the bad ID is `session_missing` with no added call, which proves it was never aliased.
   - Across all calls, argv never contains the bad ID or `/api/session/<bad>`, and every child is dead.
3. **Malformed stored ID on resume, for each of `--x`, `../x`, and `""`.**
   - `session_missing` and not replay-safe.
   - Through SQLite, `resumeAgentSession` plus `runRuntimeTurn` on `agent_session_id: "../x"` gives `failed/session_missing`, and the DB row is unchanged.
   - Zero fake CLI calls.

I also ran a mutation check on the `dist` copy, which I restored afterwards. With the L1 condition removed and the pattern loosened to `.*`, all three new tests fail.

## Verification

- `npm test`: 140 tests, 140 pass, 0 fail, 0 skipped, 0 todo. That is the earlier 137 plus 3.
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null` on both OpenCode files: no whitespace output.
- `dist/test/opencode-runtime.test.js` run 6 more times: 14/14 each time.
- No stray fake processes or `inoai-*` temp dirs remain.

## Suggested next step

Re-review the L1 and L2 fix (reviewer, `code-review`).
