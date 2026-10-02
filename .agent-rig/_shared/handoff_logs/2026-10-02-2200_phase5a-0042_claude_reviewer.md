---
agent: reviewer
role: reviewer
tool: claude
task: task-0042
task_title: "Phase 5a: Claude runtime adapter"
status: handoff
---

# task-0042 reviewer handoff

Verdict: **changes requested** (one blocking finding, F1). Task status left at `review`; nothing committed. No implementation edits made.

Read: `AGENTS.md`, reviewer role files, handoff skill, task-0042, worker handoff `2026-10-02-2156_phase5a-0042_claude_worker.md`, `docs/phase-5a-claude-cli-spike.md`, proposal "Claude runtime (Phase 5a)" and design principle 4 ("Explicit reset ... a long thread never silently loses its context"), ADRs 0002, 0007, 0008; diffs of `src/claude-runtime.ts`, `src/test/claude-runtime.test.ts`, `src/index.ts`, `src/agent-session.ts`, `src/database.ts`, `src/test/transport.test.ts`; compared with `src/codex-runtime.ts`, `src/runtime-turn.ts`, `src/conversation-worker.ts`.

## Findings

### F1 (Medium, blocking): resuming an unknown session silently starts a new conversation under the same ID
`src/claude-runtime.ts:82-86` (with `notFound` at 191-193). After a restart, every bound session starts in state `unknown`. If `--resume` returns "No conversation found", the same Turn is retried with `--session-id`, so a fresh conversation is created under the thread's ID and nobody is told.

- **Reachable in normal operation where context is really lost:** Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by default) at startup. A Discord thread that sits idle for more than 30 days, with a bridge restart in between, which is likely over that span, silently loses its context. The same happens if the project path's real path changes (the encoded-cwd folder no longer matches), if `CLAUDE_CONFIG_DIR` or the config folder changes, or if transcripts are deleted by hand. The worker's own residual-risk note names the first of these.
- **Legitimate cases the fallback covers:** the first Turn failed before init (spawn error, CLI crash, or bridge crash between `bindAgentSession` and spawn), followed by a restart. No context exists, so nothing is lost.
- **Codex parity:** Codex fails closed. `CodexRuntime.resumeSession` (`src/codex-runtime.ts:32-35`) throws when `thread/resume` fails, and `ConversationWorker.process` (`src/conversation-worker.ts:164-172`) records "Agent Session setup failed before runtime start" and posts a failure notice. The thread stays failed until `/inoai reset`.
- The fallback contradicts proposal principle 4 and the "match Codex unless forced" rule. The adapter cannot tell the legitimate case from the lossy one, because its only evidence (state `new`) lives in memory.
- **Fix:** remove the fallback (lines 82-86). When `--resume` reports not-found for an `unknown` or `persisted` session, fail the Turn without replay (for example `RuntimeFailure("pre_start", false)`, or a dedicated signal), and show a notice saying the Claude conversation for this thread is no longer available and to use `/inoai reset`. A thread whose first Turn never started before a restart then needs one reset, and no context is lost.
- If the planner wants automatic recovery for that rare case, gate it on durable evidence instead of process memory. For example, the session layer could pass a fact recorded in SQLite that no Turn of this Agent Session ever reached init. That widens the seam, so it is a planner decision.
- Update `src/test/claude-runtime.test.ts:247-254` to assert that an unknown not-found resume fails, is not retried as `--session-id`, and is not replay-safe. Update the worker handoff's Session-lifecycle notes to match.

### F2 (Low): a not-found resume is labelled replay-safe `pre_start` and retried pointlessly
`src/claude-runtime.ts:98`. For a `persisted` session (and for `unknown` once F1 is fixed), a not-found result has no init, so it is classified `pre_start` with replaySafe=true. `runRuntimeTurn` retries it 3 times, then posts "Claude could not start the turn. Please send a fresh request." A fresh request can never succeed.

**Fix:** handle `notFound(result)` before the generic `!attempt.started` branch. Make it non-replay-safe, with the reset-guidance notice from F1.

### F3 (Low): first-Turn state tracked only in memory (ruling on the specific concern)
- **Bridge crashes after the CLI persisted but before init was observed:** on restart the state is `unknown` and `--resume` finds the transcript, so this is fine. If the CLI had not persisted yet, the Turn goes down the F1 path. Fixing F1 makes that a fail-closed reset prompt.
- **In-process "persisted on disk but state still `new`":** effectively unreachable. stdout is drained until close, so an emitted init is always observed, and the CLI emits init before writing anything.
- **The reverse case, init seen but no transcript written:** this can leave the session stuck in-process. For example, a first-Turn authentication failure after init may or may not write a transcript (unverified). The state becomes `persisted`, and the next Turn resumes, gets not-found, and is retried until a restart. The F1/F2 fix turns this into a clear reset notice.
- **Optional:** add a fake-CLI regression for "first Turn fails with authentication after init, then the owner retries".

Not blocking beyond F1/F2.

### F4 (Low): a cancel before init is reported as replay-safe `pre_start`, not `cancelled`
`src/claude-runtime.ts:98-99`. The `!attempt.started` check runs before the `cancelRequested` check. `runRuntimeTurn` and the worker check the abort signal, so nothing is replayed in practice. Still, the runtime's own classification is wrong.

**Fix:** check `active.cancelRequested` before `!attempt.started`, then add a fake-CLI case.

### F5 (Info): PATH restore in the transport test
`src/test/transport.test.ts:663`. If `PATH` was unset, `process.env.PATH = previousPath` sets it to the string `"undefined"`.

**Fix:** `if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;`.

Otherwise the test is robust and isolated:
- `PATH` points to a temp dir that has no `claude`, so the spawn gets ENOENT and the real CLI never runs.
- `node --test` runs each file in its own process.
- Tests inside a file run one after another.
- Discord login is asserted not to happen, and the lock is released.

### F6 (Info): the worker's `git add -N`
`git ls-files -s` shows both new files in the index as intent-to-add with the empty blob `e69de29`. No content is staged, `git diff --cached --check` is clean, and nothing was committed. That fits "do not commit", but it is still an index change, and it makes the files show as `A` in `git status`. It is reversible with `git reset -- src/claude-runtime.ts src/test/claude-runtime.test.ts`. Acceptable; the planner should just be aware of it.

## Confirmed clean
- **Spawn and argv safety:**
  - `spawn` is called without a shell. cwd is the project path. stdio is `[pipe, pipe, ignore]`, and the env is inherited unchanged.
  - argv is exactly `-p --output-format stream-json --verbose --include-partial-messages (--session-id|--resume) <uuid> --append-system-prompt=<agent.md> --system-prompt-snapshot off --permission-prompts none [--model=<v>]`.
  - It has no bypass, allowed-tools, settings, permission-mode, MCP, add-dir, or bare flags. The test asserts this at `claude-runtime.test.ts:114-116`.
  - The prompt goes in on stdin, and a test with a flag-like prompt covers it.
- **Raw tool data:** tool_use, tool_result, `permission_denied`, `permission_denials`, `errors`, and stderr are never yielded, logged, or persisted. The secret-marker test covers this. Only top-level `text_delta` progress and `result.result` are yielded.
- **Classification:** Turns are classified from the `result` event and flags, never the exit code. The cases are tested:
  - Not-logged-in exits 1 with `subtype:"success"` and maps to `authentication`.
  - `aborted_streaming` with exit 0 and no cancel maps to `uncertain`.
  - A mismatched init session maps to `uncertain`.
- **Replay safety:** only a spawn error or a missing init gives a replay-safe `pre_start`, as ADR 0002 requires. A timeout is not replay-safe.
- **Idle timeout:** 300 s, refreshed on each stdout line. It sends SIGTERM, then SIGKILL after 10 s, and the test asserts the process is dead.
- **Cancel:** SIGINT, then waits for close. The result is `cancelled`, and the session resumes afterwards.
- **close():** stops active children with SIGINT and refuses later Turns with `pre_start` (Codex parity). A generator the consumer abandons still stops its child.
- **`ClaudeRuntime.connect()`:** `claude --version`, no shell, stdio ignored, 10 s SIGKILL cap. It rejects on spawn error, non-zero exit, or a kill. It reads no credentials (the credential guard is task-0044).
- **Wiring in `src/index.ts`:** the `claude` branch is wired. The lock is released on a startup failure, which the test covers. Codex behavior is unchanged: the probe still runs only for a real Codex runtime, and a supplied runtime still gives `false`.
- **Binding actor:** `runtime:${agent_provider}` gives `runtime:codex` for Codex (unchanged) and `runtime:claude` for Claude (tested). Error strings are provider-neutral.
- **Tests:**
  - They use a fake Node CLI in `mkdtemp` folders and temp runtime homes only. No real CLI runs and no `.inoai-connect*` is touched.
  - The Claude file passed 5/5 extra standalone runs, 10/10 each time.
- **Residual risk (by design, matches spec):** a tool that runs silently for more than 5 minutes hits the idle timeout. Codex's timer has the same shape.

## Checks
- `npm test` (build + all tests): 102 tests, 102 pass, 0 fail
- `node --test dist/test/claude-runtime.test.js` x5: 10/10 pass each run, no flakes
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean; `git diff --cached --check`: clean
- `claude --version`: `2.1.287 (Claude Code)` (the only real-CLI call; no `.inoai-connect*/.env` was read)

## Next
Set task-0042 back to `in_progress`. A worker fixes F1 and F2 (and F4/F5 if cheap): remove the unknown-resume fallback, give not-found resumes a fail-closed, non-replay-safe classification with `/inoai reset` guidance, and add regression tests. Then run an independent re-review. If the planner prefers keeping auto-recovery for never-started first Turns, that decision (durable SQLite evidence through the seam) should be made first. Do not unlock tasks 0043, 0044, or 0046 until then.
