---
agent: worker
role: worker
tool: claude
task: task-0043
task_title: "Phase 5a: Fail-closed Claude permission denials"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0043 worker handoff

Status set to `review`. Nothing staged or committed. No real CLI run; no `.inoai-connect*/.env` read.

## Seam choice

A constructor callback, `ClaudeRuntimeOptions.onPermissionDenied(agentSessionId, count)`, not a new `RuntimeEvent`.

- It mirrors the Codex shape: `ApprovalRelay` is a side listener keyed by agent session ID and wired in the provider switch. The Claude notifier does the same thing, without a server listener.
- A new `RuntimeEvent` member would touch `agent-runtime.ts`, `runtime-turn.ts`, and the conversation worker, all shared with Codex, plus every fake runtime in the tests. The callback touches only Claude code and the `claude` branch of `src/index.ts`.
- The listener gets only the session ID and a count. Raw tool input never leaves `ClaudeRuntime.attempt`.

## Behaviour

- **Detection:** `src/claude-runtime.ts` counts `system/permission_denied` events and reads `result.permission_denials.length`. After the stream ends, if `max(both) > 0`, it calls the listener once per `runTurn`, before the result is classified. That means it fires for both successful and failed Turns. A throw from the listener is swallowed, and the Turn's outcome is unchanged.
- **Detection is not:** `tool_result.is_error`. That flag also fires for non-permission tool errors.
- **Notifier:** `claudePermissionDenialNotifier` (`src/approval-relay.ts`) looks up the active `claude` session by `agent_session_id`.
  - It records one `approval_unsupported` Event with actor `runtime:claude` and detail `declined: no safe action preview; denials=<n>`.
  - The detail is a count only. Tool names are left out because MCP tool names can expose server or integration names.
  - It sends the fixed notice and archives it as a `completed` agent Message (actor `transport:discord`), the same way the Codex relay does.
  - Send and archive failures are swallowed and never logged.
- **Codex:** `ApprovalRelay` is unchanged.
- **CLI argv:** unchanged. No allow-rule or permission-mode flag was added.

## Files

- `src/claude-runtime.ts` (untracked)
- `src/approval-relay.ts` (appended a function; the Codex class is unchanged)
- `src/index.ts` (the claude provider-switch branch)
- `src/test/claude-runtime.test.ts` (untracked; 2 new tests)

## Tests

New end-to-end test: fake CLI, real SQLite, `ConversationWorker`, and the notifier, over 3 Turns:
1. Two denials, then success.
2. A denial reported only in the result, on a failed Turn.
3. A clean Turn.

It asserts:
- Exactly 2 notices and 2 Events (`denials=2`, `denials=1`), and 2 archived notices.
- Both answers are delivered, and the user rows are completed / failed / completed.
- 0 `approvals` rows.
- Every send is a plain `(thread, text)` call.
- `sk-test-…` and `ghp_…` tokens placed in tool input, the denial message, the tool result, and `permission_denials` appear nowhere in any SQLite table, in sends, or in captured console output.
- No permission flags in argv.

Second test: a throwing listener does not change the answer.

## Checks

- `npm test`: 108 tests, 108 pass, 0 fail.
- `node --test dist/test/claude-runtime.test.js`: 15/15 pass.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on both untracked files: no whitespace errors.

## Risk / notes for reviewer

- The provider-switch wiring is covered by typecheck only. The existing claude-provider `run()` test uses an empty PATH, so `connect` fails before wiring.
- The notice can be sent before or alongside the answer chunks, the same as the Codex relay's timing.
