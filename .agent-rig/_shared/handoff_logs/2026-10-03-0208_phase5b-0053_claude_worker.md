---
agent: worker
role: worker
tool: claude
task: task-0053
task_title: "Phase 5b: Fail-closed OpenCode permission denials"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0053 worker handoff

The task status is now `review`. Nothing is staged or committed. I read no `.inoai-connect*/.env`, OpenCode config, OpenCode DB, or credentials.

## Seam

- `OpenCodeRuntimeOptions.onPermissionDenied(sessionId, count)` mirrors the Claude callback. No shared seam changed: `agent-runtime.ts`, `runtime-turn.ts`, and `database.ts` are untouched.
- **Counting** (`src/opencode-runtime.ts`):
  - Counts only stdout `tool_use` events with `part.state.status === "error"` and a string `part.state.error` that starts with "This non-interactive run cannot ask the user for permission".
  - stderr is still `ignore`d. Nothing else from `tool_use` is kept.
  - Events skipped after a session mismatch are not counted.
- **Call timing:** at most once per Turn, after `attempt` returns and before classification, so it fires on both successful and failed Turns. A throwing listener is swallowed.
- **Key choice:** the runtime passes `session.opencodeId ?? sessionId`.
  - `runRuntimeTurn` handles the yielded `{type:"session"}` event synchronously, before the generator resumes. By the time the stream ends, SQLite's active row already holds the `ses_` ID, and the `inoai-new:` placeholder no longer matches any row.
  - If no ID was streamed, no rebind happened, so the placeholder is the right key.
  - A resumed session's key is already the `ses_` ID.

## Notifier

- `src/approval-relay.ts` has a private `permissionDenialNotifier(database, transport, provider, name)`. It binds the provider in its SQL, uses actor `runtime:<provider>`, and builds the notice from a template.
- `claudePermissionDenialNotifier` delegates with `("claude", "Claude")`. The notice text, the Event detail, and the actor are byte-identical to before, and the Claude tests are unchanged and pass.
- The new `openCodePermissionDenialNotifier` uses `("opencode", "OpenCode")`.
- The Codex `ApprovalRelay` is unchanged.
- `src/index.ts`: the `opencode` branch uses `OpenCodeRuntime.connect({ onPermissionDenied: openCodePermissionDenialNotifier(instance.database, transport) })`.

## Tests

**`src/test/opencode-runtime.test.ts`**
- The fake CLI gained an optional `stderr` field.
- New end-to-end test (fake CLI, real SQLite, `ConversationWorker`, notifier), over three Turns:
  1. A first Turn (`pending:` → `inoai-new:` → `ses_` rebind) with 2 rejections, 1 failed command that mentions "permission denied", and 1 completed tool.
  2. A resumed failed Turn with 1 rejection.
  3. An ordinary failed command only.
- It asserts:
  - The listener received `[[ses_…, 2], [ses_…, 1]]`.
  - 2 notices were sent and 2 Events recorded (`denials=2`, `denials=1`, actor `runtime:opencode`), plus 2 archived notices (`completed`, `transport:discord`).
  - The answers were delivered and the user rows are completed / failed / completed.
  - There are 0 approvals rows, and every send is a plain `(thread, text)` call.
  - `sk-test-…` and `ghp_…` tokens planted in the input, `rawInput`, error text, and stderr appear nowhere in a full SQLite dump, in sends, or in captured console output. The same holds for the resource strings.
- New test: a throwing listener does not change the answer, and a clean Turn makes no call.

**`src/test/transport.test.ts`**
- The existing OpenCode `run()` wiring test was updated. It used to assert that nothing in sends contained "permission", which the notice now contradicts.
- Its fake `opencode` on PATH now emits 2 rejections and 1 failed command, with tokens in the input, error text, and stderr.
- It asserts exactly 1 notice sent, 1 Event (`denials=2`, `runtime:opencode`), 1 archived notice, 0 approvals, and no tokens or resource strings in sends, console, or a full SQLite dump.
- PATH, HOME, and cwd are restored as before, deleting each one that was originally unset.

**Mutation check:** I removed the prefix condition in the `dist` copy, and both OpenCode denial tests failed. The copy is restored.

## Real check (1 prompt)

- Setup: absolute `/Users/toni.lim/.opencode/bin/opencode` (2.0.22), `run --format json --standalone`, a fresh `mktemp -d` cwd containing `secret.env` (`FAKE=not-a-secret`), and a stdin prompt asking it to read `secret.env` and list `/usr/share`.
- Result: exit 0. stdout had 2 `tool_use` events, both `status:"error"` with the fixed prefix, and 0 other tool errors. stderr had 2 auto-rejecting lines (`read` and `external_directory`).
- **The stdout count (2) equals the stderr count (2).** The `external_directory` rejection produces its own stdout event, which resolves spike open question 4.
- Cleanup: the session was deleted (exit 0), and `GET /api/session/<id>` afterwards exited 1. The temp dir was removed. Only counts were printed.

## Checks

- `npm test`: 142 tests, 142 pass. The baseline was 140; after the change, before I updated it, the existing wiring test failed as expected.
- Affected test files (opencode, transport, claude, approval-relay) re-run 3 times: 59/59 each time.
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null` on both untracked OpenCode files: no output.
- No stray `inoai-*` temp dirs or fake processes.

## Changed files

- `src/opencode-runtime.ts`
- `src/approval-relay.ts`
- `src/index.ts`
- `src/test/opencode-runtime.test.ts`
- `src/test/transport.test.ts`
- the task-0053 Notes

## Suggested skills

`code-review` for the independent reviewer.
