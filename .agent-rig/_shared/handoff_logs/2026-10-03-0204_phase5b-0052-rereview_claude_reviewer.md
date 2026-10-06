---
agent: reviewer
role: reviewer
tool: claude
task: task-0052
task_title: "Phase 5b: OpenCode runtime adapter"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0052 re-review handoff (after the L1/L2/L4 fix round)

This was an independent re-review. I made no implementation edits and did not change the task status. Nothing is staged or committed. I read no `.inoai-connect*/.env`, OpenCode config, OpenCode DB, or credentials. The only real CLI call was `~/.opencode/bin/opencode --version` (v2.0.22). A pre-existing owner `opencode serve --service` process, started 2026-10-02 21:45, was not touched.

**Verdict: clean, no findings.** The task can be marked `done` by the manager.

## Verified

**L1 fixed** (`src/opencode-runtime.ts:103`)
- Success now also requires `session.opencodeId`.
- A stream with no `sessionID`, or a non-string one, falls through to `uncertain` (not replay-safe).
- Test `:417`: two Turns, both `uncertain`, both plain `baseArgv`, children dead. No silent new session is reported as success.

**L2 fixed** (`:21`, `:75-76`, `:188-195`, `:131`, `:159`)
- `/^ses_[A-Za-z0-9]+$/` is enforced on streamed IDs. An empty string is also rejected, because `typeof "" === "string"` reaches the test.
- A malformed streamed ID sets `mismatched`, sends SIGINT, and skips all later events (`:188`). It is never assigned to `opencodeId`, aliased into `sessions`, or yielded as `session`, so it never reaches the SQLite rebind. Existing state is not overwritten.
- A stored ID that fails the pattern (including legacy `inoai-new:`) is `orphaned` and gets `session_missing` at `:84`, before any spawn.
- `opencodeId` is set only for valid IDs, so argv `--session` and `/api/session/<id>` only ever see `ses_…`.
- Tests:
  - `:434` covers `--x`, `../x` and `""` on a new session and on a resumed one. It also shows the malformed ID was never aliased, by resuming it and getting `session_missing` with no extra call, and asserts argv and the API path exclude the bad ID.
  - `:474` covers the same three values through real SQLite with `resumeAgentSession` and `runRuntimeTurn`: `failed/session_missing`, row unchanged, zero CLI calls.

**L3 docs accurate**
- `docs/sqlite-schema.md:193` describes `pending:` → `inoai-new:<uuid>` → `ses_…`, and it matches the code:
  - `src/index.ts:91,148` writes the `pending:` placeholder.
  - `agent-session.ts:12-13` and `bindAgentSession` (`database.ts:466-469`) move it to `inoai-new:`.
  - `rebindAgentSession` (`database.ts:475-481`) is a compare-and-set on the placeholder that requires an active, non-deleted row and refuses `pending:`. It is called from `runtime-turn.ts:47-51` with actor `runtime:<agent_provider>`, which is `runtime:opencode` here.
  - The restart case (`inoai-new:` → `session_missing` → reset notice) is correct.
- The statement "Codex and Claude return their final ID at creation" holds: Codex returns the thread ID and Claude returns a UUID.
- The proposal's interface block (`:79`) correctly describes the single late `session` event (`agent-runtime.ts:13-16`).

**L4 comment matches behavior** (`:85-86`)
- In-process, `opencodeId` is undefined, so the run has no `--session` and starts fresh. After a restart the `inoai-new:` key fails the pattern and is orphaned, giving `session_missing`.
- This follows the planner decision (Claude parity). There is no behavior change.

**No regressions to the prior review's clean findings**
- Argv is unchanged: `run --format json --standalone [--session id]`, and the check is `api --standalone GET /api/session/<id>`.
- There is no `env` option, no model/auto/yolo/dangerously flag, and no config write. A grep confirms this.
- Precedence order is unchanged: spawn, then timed_out, then authentication, then usage, then cancelled, then uncertain.
- The existence check is unchanged (once per process, bounded, read-only).
- The kill guard, SIGINT cancel, timeout and close are unchanged.
- Nothing from `tool_use` is kept.
- The shared seam (`agent-runtime.ts`, `runtime-turn.ts`, `database.ts`) is unchanged since the prior review, and Codex and Claude are untouched.

## Checks

- `npm test` (build + all): 140 tests, 140 pass, 0 fail, 0 skipped, 0 todo. That is the earlier 137 plus 3.
  - `opencode-runtime.test.ts` holds 14 tests: the original 11 names are all present, plus 3 new ones.
  - There is no `.skip`, `.only`, or `.todo`.
- `npm run typecheck`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on `src/opencode-runtime.ts` and `src/test/opencode-runtime.test.ts`: no output.
- `dist/test/opencode-runtime.test.js`: 5 sequential runs at 14/14, plus 6 parallel runs at 14/14 alongside a parallel full suite at 140/140. No flakes.
- No stray fake processes and no `inoai-*` temp dirs remain.

## Residual (unchanged, informational)

- In-process aliasing of a valid but colliding `ses_` ID on a unique-index conflict is still only theoretical, as noted in the prior review.
- The authentication/usage notice passthrough in `ConversationWorker` is tracked separately (task-0057) and is not part of 0052.
