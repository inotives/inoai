---
agent: reviewer
role: reviewer
tool: claude
task: task-0059
task_title: "Phase 6: Runtime review seam"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0059 reviewer handoff

Verdict: **changes requested (one Medium finding)**. Task status left at `review`; nothing staged or committed. No implementation edits were made.

Inputs read: task-0059, worker handoff `2026-10-03-0837_phase6-0059_claude_worker.md`, `docs/phase-6-claude-review-spike.md`, ADRs 0001/0002/0007/0010, Phase 6 in `docs/implementation-phases.md`, and the diff to `src/agent-runtime.ts`, `src/claude-runtime.ts`, `src/codex-runtime.ts`, `src/concurrency-probe.ts`, `src/opencode-runtime.ts`, `src/test/approval-relay.test.ts`, and the new file `src/test/runtime-review.test.ts`. Approval relay and app-server code were also read for interference.

## Findings

### M1 (Medium): an abort during temp-dir creation is lost, so the review runs until timeout

`src/claude-runtime.ts:154` and `src/codex-runtime.ts:145` check `signal.aborted` once, then `await mkdtemp` (plus `realpath` for Claude). The `abort` listener is only attached later: Claude at `src/claude-runtime.ts:219`, after spawn; Codex at `src/codex-runtime.ts:164`. `addEventListener("abort")` never fires for a signal that is already aborted, so an abort in that window is dropped. The full model call then runs and ends as `timed_out` instead of `cancelled`.

Reproduced with fakes (scratch scripts, not committed): calling `review()` and then `controller.abort()` synchronously gave `kind: timed_out after 1503 ms` for Codex (it sent `thread/start`, `turn/start`, then `turn/interrupt`) and `kind: timed_out after 1509 ms` for Claude, with `reviewTimeoutMs` of 1500 in both. With the 600 s default, a review deferred by an owner Message (Phase 6 task 5, task-0061) would keep running for up to 10 minutes. It would also be misclassified as a timeout, which the engine may count as a consumed attempt instead of a deferral.

**Fix:** in both adapters, right after `signal?.addEventListener("abort", onAbort, { once: true })`, add `if (signal?.aborted) onAbort();`. Alternatively, re-check `signal?.aborted` after `mkdtemp`/`realpath` and throw `cancelled` before spawning or calling `thread/start`, removing the temp cwd first. Add a regression test per adapter: call `review()` and abort synchronously in the same tick; expect `cancelled`, no spawn or no `turn/start` (or an immediate stop), and the cwd removed.

### L1 (Low, test gap, optional): untested fail-closed branches

There is no test for `mcp_servers` absent from init, for `apiKeySource` absent, or for `ClaudeRuntime.close()` while a review is active. The code handles all three (`isEmptyList` fails a missing field, `!== "none"` refuses a missing `apiKeySource`, and `close()` stops `review:*` entries), so this is coverage only. Suggest adding the first two to the existing case table.

## Residual risks (non-blocking; for the planner and owner)

- **Codex owner config still loads.** ADR 0010 accepts read-only plus `never` for Codex. The ephemeral review thread still loads the owner's `~/.codex` config, including configured MCP servers and global AGENTS.md. The read-only sandbox does not restrict MCP tools. The item allowlist fails closed on `item/started`, which detects a tool call after it is dispatched but does not prevent it. Codex is fake-tested only in this phase. Consider a config override in `thread/start` that disables MCP and web search (if app-server supports one) before Codex reviews are enabled live.
- **Codex allowlist can reject benign items.** It accepts only `userMessage`, `agentMessage`, and `reasoning`. Item types such as `plan` or `contextCompaction` would fail the review. That failure is replay-safe and retried, so I judge the safety trade acceptable.
- **Unbounded `turn/start` handoff.** If `turn/start` errors or times out (30 s), the turn may have started with an unknown ID, so it cannot be interrupted. The thread is ephemeral and read-only, so the impact is minimal.

## Verified OK

- **Claude argv:** exactly the spike set plus `--safe-mode --system-prompt <reviewInstructions>`, with `--model=` only when set. No shell, prompt on stdin, stderr ignored, env inherited unchanged. It never passes `--append-system-prompt`, `--resume`, `--session-id`, `--continue`, or bypass/allow/permission-mode flags (the test asserts this).
- **Fresh temp cwd, no `projectPath`:** consistent with ADR 0010 and spike finding 6. It also keeps cleanup off the owner's real project folder under `~/.claude/projects`. Accepted.
- **Claude fail-closed:** the `apiKeySource` check, `memory_paths` (non-empty), `tools`/`mcp_servers` (missing or non-empty), any `*tool_use` block, `permission_denied`, and non-empty `permission_denials` all SIGKILL immediately and yield no text. All are replay-safe. Success requires init plus a successful `result` event. Timeout escalates SIGTERM, then SIGKILL after 10 s. Abort sends SIGINT. The pid guard and 2 s exit grace are in place. Cleanup removes the cwd, calls `removeProbeProjectFolder` (which tolerates a missing folder), and logs the fixed, path-free warning. The `review:<uuid>` keys in `active` never collide with Session IDs.
- **Codex:** `thread/start` uses `{cwd: tmp, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, developerInstructions}` and `turn/start` uses readOnly/never. The review never enters `sessions` or `active`. Listeners are removed in `finally` (no leak). Notices are filtered by the review's own `threadId`/`turnId`, and chat Turns filter by their own `threadId`, so neither interferes with the other. Interrupt targets only the review turn, and the review never calls `server.close()`. The approval relay declines review-thread requests, finds no Session, and writes no SQLite rows or Discord messages (test passes).
- **OpenCode:** `review = undefined`; nothing is spawned.
- **Seam:** a single optional method (ADR 0001). Chat Turn code paths are unchanged, and none of the 144 existing tests were changed or removed (the `approval-relay.test.ts` diff only adds a test). The `reviewInstructions` text treats the transcript as data, has no tools, asks for JSON only, and contains no tool-use wording.
- **No logging:** no prompt or output text is logged or persisted. The only log line is the fixed `console.warn`.

## Checks

- `npm test`: 156 pass, 0 fail, 0 skipped (HEAD had 144; this adds 12, removes none; no `.skip`/`.only`).
- `npm run typecheck`, `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null` printed no warnings for `src/test/runtime-review.test.ts`, ADR 0010, or the spike doc.
- `runtime-review.test.js` run 5x serially: 11/11 each time. Run 4x in parallel together with `approval-relay.test.js`: 13/13 each time.
- Real CLI: only `claude --version` (2.1.288). No `.inoai-connect*/.env` was read.
- Leftovers: no `inoai-*-review*` temp dirs, no matching `~/.claude/projects` folders, no `fake-claude` processes. Scratch fake files were confined to the session scratchpad.

## Next

Return task-0059 to `in_progress` for a focused M1 fix with regression tests (L1 optional), then re-review. Do not unblock task-0060 until the re-review is clean.

## Suggested skills

`code-review` (re-review).
