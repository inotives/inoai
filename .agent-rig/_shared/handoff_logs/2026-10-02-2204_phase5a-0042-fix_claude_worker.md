---
agent: worker
role: worker
tool: claude
task: task-0042
task_title: "Phase 5a: Claude runtime adapter"
status: handoff
---

# task-0042 worker fix handoff

Read: `AGENTS.md`, the worker role, task-0042, my earlier handoff `2026-10-02-2156_phase5a-0042_claude_worker.md`, the reviewer handoff `2026-10-02-2200_phase5a-0042_claude_reviewer.md`, and `src/claude-runtime.ts`, `src/codex-runtime.ts`, `src/conversation-worker.ts`, `src/runtime-turn.ts`, `src/agent-runtime.ts`, and the related tests. Planner decision on F1: remove the automatic fallback, with no SQLite-gated recovery.

## Findings and fixes

- **F1 (Medium): unknown resume silently recreated the session.** I removed the fallback in `src/claude-runtime.ts`. The `"unknown"` state went with it: a Session resumed from SQLite is now `"persisted"` (lines 11, 70), so it always uses `--resume`. A not-found result throws `RuntimeFailure("session_missing")` with replaySafe=false (line 94). The old test is replaced by `src/test/claude-runtime.test.ts:250`. It covers a restarted runtime resuming a lost ID: one `--resume` call and no `--session-id` call, `session_missing`, not replay-safe. Through `runRuntimeTurn` it is attempted once and returns the reset notice. The in-process "first Turn never persisted is retried as new" case is kept at line 238.
- **F2 (Low): not-found was a replay-safe `pre_start`, retried 3 times.** Not-found is now classified before the `!attempt.started` branch (`src/claude-runtime.ts:94`), so it is not replay-safe and `runRuntimeTurn` does not retry it. Covered by test line 250 (`attempts: 1`, one CLI call) and by `src/test/runtime-turn.test.ts:75` (the no-retry kinds loop now includes `session_missing`).
- **F3 (Low, optional): init seen, then the transcript is missing.** I added a regression at `src/test/claude-runtime.test.ts:281`. A first Turn sees init and fails with authentication. The next Turn uses `--resume`, gets not-found, and yields `session_missing` (not replay-safe) instead of a retry loop.
- **F4 (Low): a cancel before init was a replay-safe `pre_start`.** `cancelRequested` is now checked before `!attempt.started`, and it counts as cancelled when the Turn never started (`src/claude-runtime.ts:95`). Test at `src/test/claude-runtime.test.ts:297`: the fake CLI hangs with no init, `cancel` SIGINTs it, the Turn is `cancelled` and not replay-safe, and the process is dead.
- **F5 (Info): PATH restore.** `src/test/transport.test.ts:663` now runs `delete process.env.PATH` when the saved value was undefined.
- **F6 (Info): intent-to-add index entries.** Ran `git reset -- src/claude-runtime.ts src/test/claude-runtime.test.ts`. `git ls-files -s` on both files is now empty, and they show as untracked `??`. Nothing is staged or committed.

## How the reset notice is surfaced (design choice)

I added a dedicated `RuntimeFailureKind` `"session_missing"` (`src/agent-runtime.ts:17-18`) instead of reusing an existing kind:

- **Why not reuse an existing kind:** `pre_start` means "could not start, send a fresh request" and is retry-eligible. `uncertain` means "outcome unknown, check the archive" and triggers the global-FIFO fallback. Neither tells the owner to reset, and both mean something else. Reusing them would have needed a side channel, such as a message match or an extra flag, to change the text.
- **The notice:** `failureNotice` in `src/runtime-turn.ts:20` builds it from `displayName`: "This thread's Claude session could not be found. Use /inoai reset to start a new session."
- **Getting it to the owner:** the worker usually archives its own generic failure or uncertain notice and ignores `outcome.notice`. So at `src/conversation-worker.ts:163` it archives `outcome.notice` for `session_missing` only. Every other reason keeps its existing notice. `session_missing` does not trigger the global-FIFO fallback, because the outcome is known and nothing ran.
- **Message state:** the user message fails with `Runtime session_missing; replay_safe=false`.
- **Test:** `src/test/conversation-worker.test.ts:254` covers this. It makes one attempt, records the failure detail, and asserts the archived agent notice text.
- **Codex:** Codex never raises `session_missing`. A failed `thread/resume` still throws from `resumeSession` and takes the existing "Agent Session setup failed before runtime start" path, so Codex behavior and text are unchanged. The Codex notice-text test still passes unchanged.

## Residual notes

- After a restart, a thread whose first Turn never reached init (for example, the bridge crashed before spawn) now needs one `/inoai reset`. No context is lost. This is the planner-accepted tradeoff.
- `docs/phase-5a-claude-cli-spike.md:132` still lists "unknown-resume / no-init error result → `pre_start` (replay-safe)" as the spike's proposed mapping. The implementation now maps not-found to `session_missing`. I left the spike record unchanged; the planner may want to annotate it.

## Checks

- `npm test` (build + all tests): 106 tests, 106 pass, 0 fail
- `node --test dist/test/claude-runtime.test.js` x5: 13/13 pass each run
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- Untracked files: `git diff --no-index --check /dev/null <file>` and a trailing-whitespace grep on both files are clean
- No real CLI was run, and no `.inoai-connect*` was read

## Next

Independent re-review of task-0042 (status `review`). Keep 0043, 0044, and 0046 blocked until it is clean.
