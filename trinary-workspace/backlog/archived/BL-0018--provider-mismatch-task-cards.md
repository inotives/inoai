---
id: BL-0018
title: Task cards allow actions on Tasks bound to another agent provider
type: bug
status: promoted
created_at: 2026-10-24T06:15:00Z
source: IP-0003 live owner check
promoted_to: IP-0005
---

# BL-0018: Task cards allow actions on Tasks bound to another agent provider

## Description

Each Task is bound to the Agent Session it was created in, including its `agent_provider`. After `AGENT_PROVIDER` changes, every run of an older Task fails with "Task Agent Session unavailable". Chat still offers run now, edit, and resume cards for these Tasks, and the confirm succeeds, so the owner sees a confirmed card and then nothing in the conversation. The failure report goes only to the Task's own thread.

## Reproduction

- Steps to reproduce:
  1. With `AGENT_PROVIDER=codex`, create a Task from chat (Task #4 "Drink water reminder").
  2. Change to `AGENT_PROVIDER=claude` and restart.
  3. In a new conversation, ask to run Task #4 now and click **Confirm**.
- Expected: the card warns that Task #4 belongs to the Codex provider and cannot run under Claude, or refuses the run, and points to cancel and re-create.
- Actual: proposal 10 is confirmed. Run #66 fails at once with "Task Agent Session unavailable". The conversation shows nothing more. Recurring runs keep failing every 2 hours until the Task is cancelled.

## Context and evidence

- Source: IP-0003 live owner check on `demo-test/.inoai-connect-robin`, 2026-10-24 (events 424–425; `task_runs` 66; Task #4 session 9 `agent_provider=codex`; current session 11 `agent_provider=claude`).
- Existing documented behaviour: README "Tasks in the UI" provider-change note.
- Fix ideas:
  - Mark mismatched Tasks in the per-turn Task list, for example `(other provider)`.
  - Refuse run now, edit, and resume confirms for them with a clear card message.
  - Optionally pause such Tasks at startup so they do not fail on every schedule tick.
  - Post the run failure, or a link to it, in the conversation that asked for the run.
- Related UI case: `createUiTask` (`src/ui/api/task-writes.ts`) copies `agent_provider` from the most recent owner Session, not from the current `AGENT_PROVIDER`. A UI Task created after a provider change but before a new owner conversation gets the old provider and fails the same way. The UI cannot read `.env`, so a fix needs another source, for example the runtime recording its active provider in SQLite at startup.

## Discussion

- [2026-10-24] Owner asked whether a Task needs a Session and whether Tasks can be agent-agnostic. Project-manager findings from `src/inoai/conversation/task-run-executor.ts`:
  - The Session row is still needed. It holds the Discord thread binding (report destination, Task thread guidance), the owner, the workspace, and the project path. None of these depend on the provider.
  - Only `agent_provider` and the CLI session id are provider-bound. Each run resumes the same CLI session, which gives memory of earlier runs and of Task thread messages sent before the last run.
  - The run prompt is already self-contained: title, goal, expected output, and new Task thread messages since the last run.
- [2026-10-24] Project-manager recommendation (not yet decided; discuss when this item is planned):
  - Provider-agnostic Task runs: when the Task Session's `agent_provider` differs from the active provider, start a fresh CLI session with the active provider and rebind the Session, instead of failing with "Task Agent Session unavailable".
  - Carryover on that first run: the previous run's summary from its `result.md`, and all Task thread messages, not only new ones.
  - Later runs resume the new CLI session as usual.
  - This removes the need for card or UI provider checks, so it also covers the UI case above.
  - Rejected alternatives: a fresh CLI session on every run (loses continuity every time); only warning or refusing (the current fix ideas; safe but keeps Tasks provider-bound).
  - Keep normal chat threads as they are: a thread bound to another provider still asks for `/inoai reset`, because chat context lives in the CLI session.
  - Needs its own feature and an ADR, because it changes Task run behaviour.
- [2026-10-30] Promoted to IP-0005 (Task run reliability) on branch `feat/task-run-reliability`. The feature README is canonical from now on.

## Open questions

- Adopt provider-agnostic Task runs, or keep Tasks provider-bound and only warn or refuse?
- Should Tasks switch provider automatically while chat threads keep the reset rule?
- Should a provider change pause mismatched Tasks automatically, or only warn? (Only relevant if Tasks stay provider-bound.)
