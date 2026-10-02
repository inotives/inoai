---
agent: reviewer
role: reviewer
tool: claude
task: task-0045
task_title: "Phase 5a: Provider mismatch and wrong-bot notices"
status: done
---

# task-0045 reviewer handoff

Read: `AGENTS.md`, the reviewer role, task-0045, the worker handoff `2026-10-02-2228_phase5a-0045_claude_worker.md`, Phase 5a tasks 8 and 10 and their test scenarios, ADR 0004, and the proposal's provider-mismatch bullet. I reviewed the task-0045 hunks in `src/conversation-worker.ts`, `src/transport.ts`, `src/index.ts`, `src/test/conversation-worker.test.ts`, and `src/test/transport.test.ts`. I made no implementation edits.

## Verdict

Clean. No blocking findings.

## Test-count reconciliation

- HEAD has 86 `test(` calls. The working tree has 115, which matches the `npm test` total.
- I compared test names file by file between HEAD and the working tree. No test was removed or renamed, and there is no `.skip`, `.todo`, or `.only` anywhere.
- The task-0044 reviewer saw 113 tests. Task-0045 adds 2 conversation-worker tests: "a Session from another provider is refused ... until reset starts a configured-provider Session" and "an unrecognized stored provider is never echoed into the mismatch notice". 113 + 2 = 115.
- The other task-0045 test changes extend existing tests: the controls test and the Discord interaction test.
- The worker's "5 new / 110 before" is a counting misstatement. There is no lost coverage.

## Findings

- None blocking.
- Info: the worker handoff's test arithmetic is wrong (see above). No code change is needed.
- Low/accepted: `conversationOwnedByBot` is false for any thread this bot did not create, so a human-created thread or a non-inoai bot's thread gets the "another inoai bot" text.
  - This bot only creates Sessions in threads it created itself, through `createConversation` or a reset in a thread it already had bound (`src/index.ts` top-level and reset-thread paths). So the misleading case is limited to `/inoai` typed in a thread that was never an inoai thread. The reply is private (ephemeral) and harmless.
  - Phase 5a task 10 asks for exactly this wording. I would keep it rather than make it neutral. If the owner prefers precision, a neutral alternative is "This thread isn't controlled by this inoai bot. Use the /inoai command of the bot that owns it."

## Checks

- Mismatch guard (`src/conversation-worker.ts:145-152`):
  - It runs after the active-state check and before `startAgentSession`/`resumeAgentSession`, so pending Sessions are covered.
  - There is no runtime call. The tests assert `calls == []`, and the unknown-provider runtime throws on any call.
  - It fails the Message with `Agent provider mismatch; replay_safe=false`, leaves `runtime_started_at` null, and records one `turn_failed` Event per Message with the non-secret detail `reason=provider_mismatch; attempts=0`.
  - It archives one fixed notice per Message, and the delivery loop posts it. The test asserts two confirmed notices and two sends.
  - It returns before the catch block, so there is no global-FIFO fallback.
  - It uses a fixed name map with `Object.hasOwn`, so an unknown stored value such as `@everyone toString` is never echoed.
- Codex homes when the providers match: every existing worker test passes `"codex"` with Codex Sessions, and their behavior is unchanged.
- Reset: the test is real. `/inoai reset` ends the old Session (`state=ended`, `deleted_at` null), and its 4 archived rows are kept. The next Message takes the `reset-thread` path, which creates a `claude` Session (`index.ts` uses `configuration.agentProvider`) and completes. This is consistent with ADR 0004.
- Wrong-bot reply (`src/index.ts:193-197`):
  - It is used only after the closing, guild, owner, parent, and status-channel checks pass and no active owner Session matches.
  - An intruder or the status channel in a non-owned thread still gets the generic denial (test). A bot-owned but unbound thread also keeps the generic denial.
  - It stays private (the transport defers with the Ephemeral flag), with `allowedMentions` parse empty.
- Transport (`src/transport.ts:118`): `isThread() === true && ownerId === client.user?.id` fails safe to false. The test covers both true and false.
- Seam: a required 4th `ConversationWorker` constructor argument, typed `Configuration["agentProvider"]`. Leaving it out fails to compile instead of failing open. It keeps `AgentRuntime` narrow (displayName/loginHint only), which is consistent with ADR 0001 (narrow provider adapters). I accept it.

## Command results

- `npm test`: 115 tests, 115 pass, 0 fail, 0 skipped, 0 todo
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- `git diff --no-index --check /dev/null` on `src/claude-runtime.ts` and `src/test/claude-runtime.test.ts`: no output
- No `.inoai-connect*/.env` was read. Nothing was staged or committed, and the task status was not changed.

## Next

The manager can mark task-0045 `done`.
