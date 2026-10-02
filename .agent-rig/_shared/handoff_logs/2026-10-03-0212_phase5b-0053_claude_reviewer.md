---
agent: reviewer
role: reviewer
tool: claude
task: task-0053
task_title: "Phase 5b: Fail-closed OpenCode permission denials"
status: done
---

# task-0053 reviewer handoff

Verdict: **clean**. No blocking or medium findings. Task status left at `review` for the manager; nothing staged or committed. No implementation edits. I read no `.inoai-connect*/.env`, OpenCode config, OpenCode DB, or credentials; the only real CLI call was `~/.opencode/bin/opencode --version` (v2.0.22).

Inputs: task-0053, worker handoff `2026-10-03-0208_phase5b-0053_claude_worker.md`, spike section 4, ADRs 0001/0003/0007, Claude precedent (`src/claude-runtime.ts` callback), `git show HEAD:src/approval-relay.ts`.

## Checks against scope

- **Single count source** (`src/opencode-runtime.ts:226-228`): only stdout `tool_use` with `state.status === "error"` and string `state.error` starting with the fixed prefix (`:28`). stderr stays `"ignore"` (`:172`, and `:143` for the check). Nothing from the part is retained; `Attempt` gains only a number. Non-permission tool errors are not counted (covered by both new tests via a `Command failed` / "permission denied" tool error).
- **Callback timing** (`:105-110`): after `attempt` returns (stream ended, process exited), before classification; fires on success and on every failed classification (timed_out, auth, usage, cancelled, uncertain, spawnFailed). The listener is wrapped in try/catch. It is at most once per Turn because it sits outside the event loop.
  - Timeout/cancel/close: the child is stopped, the stream ends, `attempt` returns, and the callback fires with any counted denials. That is correct, and the Claude adapter behaves the same way.
  - Malformed or mismatched streamed ID (the task-0052 L2 path): every later event is skipped (`:199`), so later rejections are not counted. Denials counted *before* a mismatch on a resumed Turn still fire under the stored `ses_` key, which matches the SQLite row. A malformed first ID leaves `opencodeId` unset, so the key is the `inoai-new:` placeholder, which still matches SQLite because no rebind happened. Fail-closed holds either way: nothing was approved, and the Turn is `uncertain`.
- **Key choice** (`session.opencodeId ?? sessionId`): correct. `runRuntimeTurn` rebinds synchronously on the yielded `session` event (`src/runtime-turn.ts:47-51`), so by stream end the active row holds `ses_…`. The transport wiring test proves this end to end (event `denials=2` is recorded against the rebound row).
  - If the rebind fails (`getSession` null, or `rebindAgentSession` throws because the row is no longer the active placeholder), `runRuntimeTurn` throws inside `for await`. That closes the generator at the yield, so `runTurn`'s callback is never reached: no lookup happens and no notice is posted. This is harmless. The rebind only fails when the row is no longer active/matching (for example reset mid-Turn), and the notifier filters on `state = 'active'`, so it would have no-op'd anyway. No secret exposure and no fail-open. See L1.
- **Notifier generalization** (`src/approval-relay.ts:51-78`): the template with `name="Claude"` reproduces the HEAD notice byte for byte. Event detail `declined: no safe action preview; denials=<n>` and actor `runtime:claude` are unchanged, and the archive actor stays `transport:discord`. The provider is bound as a SQL parameter, so the filter is correct and the type is restricted to `"claude" | "opencode"`. `ApprovalRelay` (Codex), lines 1-48, is untouched in the diff. The seam is narrow (ADR 0001): there are no changes to `agent-runtime.ts`, `runtime-turn.ts`, or `database.ts` for this task, and the OpenCode option mirrors Claude's `onPermissionDenied`.
- **`src/index.ts`**: the `opencode` branch connects with the notifier only. There is no concurrency probe, so the home keeps global FIFO (asserted via the log line in the wiring test).
- **Transport wiring test** (`src/test/transport.test.ts`, OpenCode `run()` test): not weakened. The earlier "no `permission` in sends" assertion was replaced by stricter checks:
  - exactly 1 fixed notice sent;
  - 1 Event (`denials=2`, `runtime:opencode`);
  - 1 archived notice;
  - 0 approvals;
  - rebound `ses_` row with actor `runtime:opencode`;
  - a leak regex (tokens, `sentinel`, `permission requested`, `cannot ask the user`, `external_directory`, `Command failed`) checked over sends, console, and a full dump of every SQLite table.

  The fixed notice cannot satisfy the regex, so the check is meaningful. Tokens are planted in input, error text, and stderr.
- **Spike open question 4**: the worker's real check (2 stdout rejection events == 2 stderr lines, including `external_directory`) resolves it. I did not repeat the model run, per review limits.

## Findings

- **L1 (low, no change required)** `src/opencode-runtime.ts:105-110` with `src/runtime-turn.ts:49-51`: a failed rebind or abandoned generator skips the denial callback. This is benign for the reasons above. Optional: a one-line comment noting that a closed generator intentionally reports nothing.
- **L2 (low, test gap, optional)** `src/test/opencode-runtime.test.ts`: there is no explicit test that denials fire on timeout and cancel Turns. The code path is clear and the failed-Turn case (exit 1) is covered. Optional regression: one `hang` scenario with a rejection followed by cancel, asserting a single callback and `cancelled`.

## Verification

- `npm test`: 142 tests, 142 pass, 0 fail/skipped/todo/cancelled (baseline 140 per the task-0052 re-review; +2 new, 1 updated, none removed; no `.skip`/`.only`).
- Affected files (opencode-runtime, transport, claude-runtime, approval-relay) run 3 times: 59/59 each time.
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null` on `src/opencode-runtime.ts` and `src/test/opencode-runtime.test.ts`: no output.
- No stray `$TMPDIR/inoai-*` dirs. No fake CLI processes. The only `opencode` process is the owner's own `opencode serve --service`, started 2026-10-02 21:45, which predates this work.

## Suggested skills

None needed. The manager can mark task-0053 `done` and unblock the next selected task (task-0054).
