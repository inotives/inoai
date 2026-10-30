---
status: accepted
---

# Task runs follow the active agent provider

Every Task has its own Session. Before this decision, a Task Run failed with "Task Agent Session unavailable" when that Session was bound to a provider other than the runtime home's `AGENT_PROVIDER` (BL-0018). After an `AGENT_PROVIDER` change, every existing Task failed on each run. Talking to the agent did not fix a Task. The owner had to create each Task again.

Now a Task Run switches its Task's Session to the active provider when the run starts. The run then starts a fresh agent session under that provider. The first runs after the switch get a carryover of earlier context. Chat threads keep their existing rule.

This was chosen over two alternatives:

- **A fresh agent session on every run.** It avoids provider binding, but every run loses the agent session's context, even when the provider never changes. Task threads rely on that context between runs.
- **Warn or refuse.** Provider-bound Tasks with a refusal card or notice keep the current failure and only explain it. The owner still has to create each Task again after every provider change.

## When a Task Session switches

- The switch happens only when a Task Run starts. Paused, cancelled, and completed Tasks are not touched. There is no startup sweep.
- The run switches the Session only when it is `active`, not deleted, and bound to another provider.
- A Session that is not `active` still fails the run with "Task Agent Session unavailable". The Session is not changed and no event is recorded.
- A Task Session only ever holds Task Runs and Task-thread steering messages. Chat Turns never use it, so the switch does not affect chat.

## The switch

`switchTaskSessionProvider` runs in one immediate SQLite transaction with actor `task-runtime`:

- It updates the `sessions` row in place. It sets `agent_provider` to the active provider, `agent_session_id` to `pending:task:switch:<uuid>`, and `updated_at` and `updated_by`. No row is deleted.
- The `UPDATE` is guarded on the Session id, the old provider, the old `agent_session_id`, `state='active'`, and `deleted_at IS NULL`. Only one of two concurrent run starts can switch the Session.
- In the same transaction it records a `task_provider_switched` Event on the Session with this detail:

  ```text
  task=<task id>; run=<run id>; from=<old provider>; agent_session=<old Agent Session ID>
  ```

- It returns `false` when the guard matches no row, for example because another start switched first. The run then re-reads the Session and continues with its current state.

The new `agent_session_id` starts with `pending:`, so the run calls `startAgentSession` and the CLI creates a fresh agent session. Code that recognizes a Task Session by the `pending:task:` prefix also matches `pending:task:switch:`. Task-thread steering finds its Task by conversation and Session, not by provider, so it keeps working after a switch.

If the fresh agent session fails to start, the run fails with the generic failure. The switch stays recorded. The next run retries `startAgentSession` on the same pending id.

## Carryover

A run gets a carryover block when its Session has a `task_provider_switched` Event and no run of the Task with an id at or after the switching run has completed. The run finds the switching run from the latest such Event by matching `^task=\d+; run=(\d+);` against its detail. The detail format is therefore load-bearing: changing it disables carryover.

The block comes before the "New Task thread messages" section of the prompt. It holds:

- a fixed line that says earlier runs used another agent provider;
- `Previous run answer:` — the `## Answer` text of the latest completed run's `result.md`, at most 4,000 characters;
- `Task thread messages so far:` — every completed owner message in the Task thread, ignoring `message_cursor`, at most 8,000 characters. Whole messages are kept, newest first. When the newest message alone is too long, its last 8,000 characters are kept.

The previous `result.md` is read with the same folder checks as the writer: every folder is a real directory inside `results/`. The file is opened with `O_NOFOLLOW` and `O_NONBLOCK`. It must be a regular file with one link, at most 1 MiB, with no NUL bytes, and it must say `State: completed`. A missing, unsafe, or unreadable file drops only that part; the run continues.

A failed or interrupted switched run does not end the carryover. Once a run at or after the switching run completes, later runs resume the new agent session without carryover.

## Chat threads

Chat threads keep their rule. A chat Session bound to another provider is not resumed. The owner uses `/inoai reset` or starts a new thread.

## Consequences

- Existing Tasks keep running after an `AGENT_PROVIDER` change, in their own Task thread.
- A UI-created Task that copied an old provider from the latest owner session heals on its first run. The owner does not need to talk to the agent first or create the Task again.
- The old Agent Session ID stays in the Event for audit. The old CLI session is not resumed, also when the owner switches back to the earlier provider; that is a new switch with a new fresh agent session.
- Earlier context reaches the new agent session only through the capped carryover. Older thread messages and longer answers are lost to the agent but stay in the archive and in `result.md`.
- Owner messages after `message_cursor` appear in both the carryover and the "New Task thread messages" section of the first switched prompt.
- A cancel that lands after the run's last cancel check but before the switch leaves the cancelled Task's Session switched. This is harmless: a cancelled Task never runs again.
- Only the SQLite store supports the switch. The PostgreSQL adapter has no Task support.
