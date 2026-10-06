---
agent: reviewer
role: reviewer
tool: claude
task: task-0043
task_title: "Phase 5a: Fail-closed Claude permission denials"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0043 review

Verdict: **clean. No blocking findings.** I made no implementation edits, did not change the task status, and committed nothing. No `.inoai-connect*/.env` was read. The only real-CLI call was `claude --version`.

Read: `AGENTS.md`, the reviewer role, the task, the worker handoff `2026-10-02-2210_phase5a-0043_claude_worker.md`, the 0042 re-review handoff, spike section 4, and ADRs 0001, 0003, and 0007. Diffed: `src/claude-runtime.ts` (untracked), `src/approval-relay.ts`, `src/index.ts`, and `src/test/claude-runtime.test.ts`.

## Acceptance
- **One notice and one Event per denied Turn.** `runTurn` calls the listener at most once (`src/claude-runtime.ts:88-91`), with `max(permission_denied events, result.permission_denials.length)`. The notifier (`src/approval-relay.ts:55-70`) writes one `approval_unsupported` Event with the fixed detail `declined: no safe action preview; denials=<n>`, actor `runtime:claude`. It then sends the fixed notice once and archives it as a `completed` agent Message. This is the same shape the Codex relay uses.
- **The Turn's outcome is unchanged.** The callback runs inside a try/catch, before classification, and classification does not read the denial count. The test covers both a successful Turn and a failed Turn, and a throwing listener.
- **No approval rows and no controls.** Nothing inserts into `approvals`. Every send is a plain `(thread, text)` call. The test asserts 0 approval rows and 2-argument sends.
- **No permission-changing flags.** Argv is unchanged from 0042. Only the restricting `--permission-prompts none` (owner decision D2) is passed, and tests assert no `--allowedTools`, `--permission-mode`, `--dangerously*`, or `--settings`.

## Secret safety
- `permission_denied` events only increment a counter. `result.permission_denials` is read only for its `.length`. `tool_input`, `message`, and `tool_name` never leave `attempt()`.
- The listener receives only the session ID and a number. The Event detail is a constant plus the count, and the notice is a constant.
- Send and archive errors are swallowed by `.catch(() => {})`, with no logging.
- If `createEvent` throws synchronously (for example, the database is closed during shutdown), the runtime's try/catch catches it, so the Turn's outcome is unaffected and nothing is logged.
- Stderr is still ignored.
- The test puts `sk-test-…` and `ghp_…` tokens in tool input, the denial message, the tool result, and `permission_denials`. It then checks a full dump of every SQLite table, all sends, and captured console output. None of them contain the tokens.

## Counting and timing
- **Using `max` cannot double-post.** There is a single call per `runTurn`. It does not miss a denial reported only in the result (Turn 2 of the test). It does not miss one seen only as a stream event either, for example when a timeout or cancel kills the process before the result arrives.
- **Retries cannot repeat the notice.** `runRuntimeTurn` retries only replay-safe `pre_start`/`timed_out`. Claude's `timed_out` is not replay-safe. Its replay-safe `pre_start` happens only on a spawn failure or a never-started Turn, and neither can carry denial events. So in practice there is at most one notice per Turn.
- **Timing on each path:**
  - **Success and result failures:** the callback fires after the stream ends and before classification.
  - **Idle timeout and cancel mid-stream:** SIGTERM or SIGINT closes stdout, the loop ends on `ended`, and `attempt()` returns normally. The callback then fires with whatever denials were already seen. It does not fire when there were none.
  - **Spawn failure:** no events arrive, so it does not fire.
  - **`close()` during shutdown:** same as cancel. A send failure is swallowed.
- **The generator is never abandoned early.** `runRuntimeTurn`'s default `onProgress` is a no-op and the worker passes `undefined`, so the post-`yield*` code always runs.

## Seam
The constructor callback is narrow and consistent with ADR 0001. It touches only Claude code and the `claude` branch of the provider switch. `AgentRuntime`/`RuntimeEvent`, `runtime-turn.ts`, the worker, and the Codex `ApprovalRelay` are unchanged (confirmed in the diff).

## Session lookup and ordering
- The lookup query matches Codex: `agent_provider='claude' AND agent_session_id=? AND state='active' AND deleted_at IS NULL`. An unknown, ended, or soft-deleted session returns early with no Event and no send.
- The notice send starts before the answer is yielded. It is fire-and-forget, so it usually lands before the answer chunks, but the order is not guaranteed. That matches Codex's timing and is acceptable.

## Non-blocking observations (Low)
1. **Wiring is covered by typecheck only** (`src/index.ts`, the `claude` case). Typecheck is acceptable for this task: the call is a single expression whose types are checked, and the end-to-end test exercises the notifier with the real runtime and worker. Recommendation: when task-0044 or task-0046 touches `run()` for Claude, add a `run()` test that puts a fake `claude` (one that answers `--version`) on PATH with a supplied transport. It should assert that one denied Turn yields the notice. Do not block 0043 on this.
2. **Some paths have no dedicated tests:** denials on a cancelled or timed-out Turn (events only, no result), and the notifier ignoring an unknown or ended session. The code paths are straightforward and the lookup copies Codex's. They are optional regression tests.
3. **A denial on a Turn cancelled by `/inoai reset` may record no Event**, if the reset ends the session before the stream closes. This matches Codex's lookup semantics and is acceptable under fail-closed rules: nothing was approved.

## Checks
- `npm test`: 108 tests, 108 pass, 0 fail
- `node --test dist/test/claude-runtime.test.js` x5: 15/15 pass on every run
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- `git diff --no-index --check /dev/null` on the untracked `src/claude-runtime.ts`, `src/test/claude-runtime.test.ts`, the spike doc, and ADRs 0007 and 0008: no whitespace errors
- `claude --version`: 2.1.287 (Claude Code)

## Next
The planner can mark task-0043 `done` and unblock only the next selected dependent task.

## Suggested skills
None required. Use `code-review` for the final phase review.
