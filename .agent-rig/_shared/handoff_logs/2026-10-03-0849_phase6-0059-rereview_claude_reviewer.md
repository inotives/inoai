---
agent: reviewer
role: reviewer
tool: claude
task: task-0059
task_title: "Phase 6: Runtime review seam"
status: done
---

# task-0059 re-review handoff

Verdict: **clean, no findings.** The task status stays at `review` for the manager to set. Nothing is staged or committed, and I made no implementation edits.

Inputs read: the reviewer role, task-0059, the prior review `2026-10-03-0841_phase6-0059_claude_reviewer.md`, the fix handoff `2026-10-03-0845_phase6-0059-fix_claude_worker.md`, and the current diffs of `src/claude-runtime.ts`, `src/codex-runtime.ts`, `src/agent-runtime.ts`, `src/opencode-runtime.ts`, `src/concurrency-probe.ts`, and `src/test/runtime-review.test.ts`.

## M1: resolved

- **Claude** (`src/claude-runtime.ts:165-169`): after `mkdtemp`/`realpath` it checks `signal.aborted || this.closed`. If either is set, it removes the cwd and throws `cancelled` (abort wins) or `pre_start`, before `active.set` and before any spawn. From that check through `active.set` to `spawn` inside `reviewAttempt`, the code is synchronous, so neither an abort nor `close()` can slip in between. The same applies to `close()` iterating `active` before `child` is set. In `reviewAttempt`, `if (signal?.aborted) onAbort();` after `addEventListener` (`:225-226`) covers any already-aborted signal.
- **Codex** (`src/codex-runtime.ts:165-169`): `onAbort()` runs immediately when the signal is already aborted, and `if (failure) throw failure;` is the first statement in the `try`. So no `thread/start` or `turn/start` is sent. The `finally` block removes listeners and the cwd, and skips `turn/interrupt` because there is no `turnId`.
- **Worker's extra `closed` → `pre_start` check:** correct and replay-safe. Nothing was spawned and nothing was written. It matches the existing "after close" path at `:153` and `health()` reporting `stopped`. If both are set, `cancelled` takes precedence, which is the right classification for a deferral.
- **Mutation check:** I copied `dist/` into the scratchpad, removed both fix lines in each adapter, and ran the review test file. All three new tests failed at the 30 s timeout, and the other 11 passed. The repo was untouched and the scratch copy was deleted.

## L1: resolved

The fail-closed table now covers `missing MCP servers` (→ `uncertain`) and `missing API key source` (→ `authentication`). New tests cover:

- `close()` during a running review: rejects replay-safe, the child is dead, the cwd is gone.
- `close()` racing cwd creation: `pre_start`, no CLI call, no cwd.
- A same-tick abort, for both Claude and Codex.

## `isolatedTmp()` helper

- It restores the prior value, or uses `delete` when `TMPDIR` was originally unset, and removes its folder in each test's `finally`.
- The fake CLI dir is created before the override, so `calls()` still resolves.
- `node --test` runs each test file in its own process, and tests within the file run sequentially (no `concurrency` option). So the `process.env` change cannot reach other files, even when they run in parallel.
- The file passes with `env -u TMPDIR`. A node one-liner confirmed that `delete` leaves `TMPDIR` absent and `os.tmpdir()` back at `/tmp`.

## Regressions

None. The rest of the diff matches what the prior review confirmed. Chat Turn code paths are unchanged: the diffs only add review code plus the defaulted constructor options. No test was removed, skipped, or marked `.only`/`todo`.

## Checks

- `npm test`: 159 tests, 159 pass, 0 fail/cancelled/skipped/todo (was 156, net +3).
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null src/test/runtime-review.test.ts` printed no warnings (rc 1 only because the files differ).
- `runtime-review.test.js` run 5x serially: 14/14 each time. Run 4x in parallel with `approval-relay.test.js`: 16/16 each time. One run with `--test-concurrency=4` (the review file twice plus approval-relay): 16/16. One run with `TMPDIR` unset: 14/14.
- Leftovers: 0 `inoai-*` entries in `$TMPDIR` or `/tmp`, no matching `~/.claude/projects` folders, no `fake-claude` processes.
- No real CLI was run. No `.inoai-connect*/.env` was read.

## Residual risks

Unchanged from the prior review and non-blocking:

- The Codex owner config and MCP servers still load in the review thread.
- The Codex item allowlist is strict.
- A `turn/start` that times out cannot be interrupted.

These need attention before Codex reviews go live.

## Next

Manager: mark task-0059 `done` and unblock only the selected next task (task-0060).
