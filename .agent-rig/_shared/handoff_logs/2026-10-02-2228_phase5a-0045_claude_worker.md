---
agent: worker
role: worker
tool: claude
task: task-0045
task_title: "Phase 5a: Provider mismatch and wrong-bot notices"
status: handoff
---

# task-0045 worker handoff

Read: `AGENTS.md`, worker role, task-0045, Phase 5a tasks 8 and 10 and their test scenarios in `docs/implementation-phases.md`, ADR 0004, the proposal's Claude runtime section, and the 0041/0042 handoffs.

## Seam choice

- **Provider mismatch:** `ConversationWorker` takes the configured provider as a new required 4th constructor argument, `agentProvider: Configuration["agentProvider"]`. `run()` passes `instance.configuration.agentProvider`. I did not add a provider id to `AgentRuntime`, because the configured provider is the source of truth and the runtime only supplies `displayName` (the 0041 seam). Making the argument required means a missing provider fails to compile instead of failing open. All test call sites now pass `"codex"`, except the two Claude-session tests, which pass `"claude"`.
- **Wrong bot:** `ThreadControl` gained `conversationOwnedByBot: boolean`. Discord sets it to `channel.isThread() && channel.ownerId === client.user.id`. `index.ts` checks it only after the guild, owner, and status-channel checks pass and no active owner Session matches the thread.

## Behavior

- `src/conversation-worker.ts`: for an active Session whose `agent_provider` differs from the configured one, the check runs before `startAgentSession`/`resumeAgentSession`, so it covers pending Sessions too. The worker:
  - makes no runtime call
  - fails the Message with `Agent provider mismatch; replay_safe=false`
  - records a `turn_failed` Event with `reason=provider_mismatch; attempts=0`
  - archives one notice through `archiveFailureNotice`, which the existing delivery loop posts

  There is no global-FIFO fallback, because nothing ran.
- Notice: `This thread belongs to a Codex session. Use /inoai reset to start a new Claude session here, or start a new thread.` The stored provider's name comes from a fixed map (`codex`→Codex, `claude`→Claude, looked up with `Object.hasOwn`). Any other stored value reads "a session from a different agent provider". The current provider's name is `runtime.displayName`.
- Wrong-bot reply (ephemeral, as before): `This thread belongs to another inoai bot. Choose that bot's /inoai command to control it.` Intruder, wrong-guild, status-channel, and this-bot-owned-but-unbound rejections keep the old "only in your active inoai thread" text.
- Reset needed no code change. `/inoai reset` ends the mismatched Session (soft state change, archive kept), and the next thread Message takes the existing `reset-thread` path, which creates a Session with the configured provider.

## Tests

- `conversation-worker.test.ts`:
  - New: in a claude-configured home, a Codex-bound thread refuses two Messages with no runtime calls. It asserts the details, `runtime_started_at` null, two confirmed and sent notices, and two Events. After `/inoai reset`, the next Message creates a `claude` Session in the same thread and completes. The old Session is `ended`, not deleted, and its 4 archived rows remain.
  - New: an unrecognized stored provider (`@everyone toString`) gives the generic phrase.
  - Controls test: added wrong-bot text for reset and status, and confirmed that an intruder or the status channel in a non-owned thread still gets the generic denial.
  - `FakeTransport` now records sent text.
- `transport.test.ts`: the Discord interaction test asserts `conversationOwnedByBot` is true for a bot-owned thread and false for another bot's thread.

## Checks

- `npm test`: 115 tests, 115 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- `git diff --no-index --check /dev/null` on the untracked `src/claude-runtime.ts` and `src/test/claude-runtime.test.ts`: no output
- No `.inoai-connect*/.env` was read. Nothing was staged or committed.

## Residual notes

- `conversationOwnedByBot` is false for any thread this bot did not create, including a human-created thread. The wrong-bot text then says "another inoai bot", which is slightly imprecise for that case. Telling a human owner from a bot owner would need a Discord fetch.
- Each Message in a mismatched thread gets its own notice; this is "one notice per Message".

## Next

Independent review of task-0045 (status `review`).

## Suggested skills

- `code-review`
