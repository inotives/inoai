---
agent: reviewer
role: reviewer
tool: claude
task: task-0042
task_title: "Phase 5a: Claude runtime adapter"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0042 re-review (after fix round)

Verdict: **clean, no findings.** I made no implementation edits, left the task status unchanged, and committed nothing.

Read: the reviewer role, task-0042, the prior reviewer handoff `2026-10-02-2200_phase5a-0042_claude_reviewer.md`, and the fix handoff `2026-10-02-2204_phase5a-0042-fix_claude_worker.md`. I also read the `src/claude-runtime.ts` source and the diffs of `src/agent-runtime.ts`, `src/runtime-turn.ts`, `src/conversation-worker.ts`, `src/codex-runtime.ts`, and `src/test/{claude-runtime,conversation-worker,runtime-turn,transport}.test.ts`, plus the spike mapping table in `docs/phase-5a-claude-cli-spike.md`.

## Prior findings

### F1: resolved
- **Fallback removed.** The `"unknown"` state and the `--resume` → `--session-id` fallback are gone (`src/claude-runtime.ts:11`).
- **Restart path.** `resumeSession` (line 70) keeps the in-memory state when there is one, and otherwise sets `"persisted"`. A restarted runtime has an empty session map, so every SQLite-resumed session uses `--resume`, and `--session-id` cannot be produced for an existing thread ID after a restart.
- **The in-process "first Turn never started → new" path** is still correct (test `claude-runtime.test.ts:238`). It only applies to a session created by this process that never saw init.
- **Not-found classification.** A not-found result maps to `RuntimeFailure("session_missing")`, which is not replay-safe (line 94). It is checked after spawn, mismatch, success, timeout, auth, and usage, and before the cancel and `!started` checks. `runRuntimeTurn` retries only replay-safe `pre_start` and `timed_out`, so the Turn makes exactly one attempt.
- **The new kind is minimal.** It is one union member (`agent-runtime.ts:18`) plus one `failureNotice` case built from `displayName` (`runtime-turn.ts:20`). Because it is added as an exhaustive switch member, `tsc` would flag any missing case.
- **Worker special case** (`conversation-worker.ts:163-164`):
  - It archives `outcome.notice` only for `session_missing`. Every other reason keeps the same generic or uncertain notice as before.
  - `session_missing` is not in the `fallbackToGlobal` condition at line 159, so the global-FIFO fallback still fires only for `uncertain`/`timed_out` and for thrown errors.
- **Codex is unchanged.** Codex never raises `session_missing`, and its notice texts are pinned by `runtime-turn.test.ts`. Its `resumeSession` failure still goes through the catch path ("Agent Session setup failed before runtime start").
- **Planner tradeoff.** A thread whose first Turn never reached init before a restart now needs one `/inoai reset`. No context is lost. The planner accepted this.

### F2: resolved
A not-found result is no longer a replay-safe `pre_start`. The tests check one attempt and one CLI call (`claude-runtime.test.ts:250`, `runtime-turn.test.ts:75`).

### F3: regression test is meaningful
The test is `claude-runtime.test.ts:281`: init, then an authentication failure, then a `--resume` that returns not-found, which must give `session_missing` (not replay-safe). Argv is asserted as `--session-id`, then `--resume`. Under the pre-fix code this would have been a replay-safe `pre_start` retried 3 times, so the test would fail there.

### F4: resolved
The cancel check now comes before `!started` (line 95). Test line 297 covers a cancel before init: the result is `cancelled`, not replay-safe, and the child process is dead.

### F5: resolved
`transport.test.ts` deletes `PATH` when it was originally unset.

### F6: resolved
`git ls-files -s` returns no entries for the two new source files, which are untracked (`??`). `git diff --cached` is empty.

### Spike doc
The mapping table in `docs/phase-5a-claude-cli-spike.md` is annotated: not-found maps to `session_missing`, superseded during review.

## Safety properties re-confirmed (no regressions)
- **Spawn:** no shell, cwd set to the project, stdio `[pipe, pipe, ignore]`. Argv is unchanged apart from removing the fallback branch.
- **Raw tool data:** tool and permission events are skipped and never yielded or stored. Stderr is ignored.
- **Classification:** based on the result event, not the exit code.
- **Replay safety:** only a spawn error, a never-started Turn without a cancel, or a closed runtime is replay-safe.
- **Process lifecycle:** idle timeout sends SIGTERM, then SIGKILL. Cancel sends SIGINT. `close()` stops children and refuses later Turns.

## Checks
- `npm test`: 106 tests, 106 pass, 0 fail
- `node --test dist/test/claude-runtime.test.js` x5: 13/13 pass on every run
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- `git diff --cached`: empty
- `--no-index --check` on the untracked `claude-runtime.ts`, its test, and the spike doc: clean
- `claude --version`: 2.1.287 (Claude Code). This was the only real-CLI call. No `.inoai-connect*/.env` was read.

## Next
The planner can mark task-0042 `done` and unblock only the next selected dependent task.
