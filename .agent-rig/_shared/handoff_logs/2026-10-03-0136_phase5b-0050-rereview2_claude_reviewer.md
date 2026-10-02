---
agent: reviewer
role: reviewer
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: done
---

# Re-review 2: task-0050 OpenCode headless contract spike (after fix round 2)

## Verdict

Clean. Every prior finding (N1 to N6) is resolved, and no blocking or medium issues remain. The three informational notes below are optional wording tweaks; none of them blocks `done`.

## Prior findings

- **N1 (Medium): resolved.**
  - Spike table `docs/phase-5b-opencode-cli-spike.md:154-155` maps replay-safe `pre_start` only to a spawn failure of `opencode run` or an existence-check failure without `SessionNotFoundError`.
  - `:160` maps every other non-zero exit, signal, or `error` event to `uncertain`, including a run with zero parsed stdout events.
  - The rule at `:162` cites the spike's own evidence: the user message is stored about 0.3 s after spawn, but the first event arrives at 1.0-4.1 s, and the free-tier sample confirms it.
  - The precedence at `:164` is spawn failure, then `timed_out`, then `authentication`/`usage`, then `cancelled`, then `pre_start` (existence check), then `uncertain`. It notes why this departs from Claude's "no init event means `pre_start`" rule.
  - task-0052 `:35` states the same rule and precedence word for word.
  - This order is consistent with `src/claude-runtime.ts:109-116`, where `timed_out`, then auth/usage, then `cancelled`, then `pre_start` is the same relative order.
  - It satisfies ADR 0002 ("never started or proven no side effects").
- **N2 (Low): resolved.** `:80` is marked superseded by D1, and the prepend-then-PUT sentence is removed.
- **N3 (Low): resolved.** The task-0052 `:37` tests now cover: final-step text only, with interim tool-step text excluded; the persona block on every Turn, with the environment unchanged; the existence check run once per process per session, including an ID from a failed first Turn.
- **N4 (Low): resolved.** task-0054 `:33` describes the persona as a delimited block prepended to every Turn's prompt, and `:34` adds the free-tier note.
- **N5 (Low): resolved.** task-0053 `:30` counts only stdout `tool_use` errors that carry the fixed prefix. It never counts, stores, or logs stderr, and it keeps the real-check verification.
- **N6 (Info): resolved.** Spike `:140` says a `sessionID` from a failed or `uncertain` first Turn is checked before its first resume. task-0052 `:37` tests it.

## Remaining notes (Info, optional)

- I1:
  - Where: task-0052 `:34` says "before resuming a stored session after restart". Spike `:140` is broader: it covers any session not yet seen to succeed, including one from a failed first Turn. `docs/implementation-phases.md:201` reads as a check on every resume.
  - Why it is not blocking: the test bullet at task-0052 `:37` covers the narrower spike rule.
  - Optional fix (planner): reword `:34` to "a session not yet seen to succeed in this process".
- I2:
  - Where: spike `:138` says "any other failure" of the existence check maps to `pre_start`, while table `:155` lists only "exit 1 without SessionNotFoundError, or fails to spawn". The precedence list at `:164` also does not mention `session_missing`.
  - Why it is not blocking: both outcomes come from the pre-run check, before `opencode run` spawns, and both wordings give a replay-safe result.
- I3:
  - Where: no table row covers exit 0 with no `error` event but no final-step text.
  - Why it is not blocking: the general "unknown → `uncertain`" in task-0052 `:35` already fails closed.
  - Optional fix: task-0052 could add one fake-CLI case for this.

## Contradiction sweep

- I checked these against the spike doc: `docs/implementation-phases.md:199-214`, the proposal `:104`, plan-review decision 29 and decision 12, `implementation-phases.md:100`, ADR 0002, and tasks 0052, 0053 and 0054.
- Phrases such as "retry only never-started Turns" and "a timeout or process loss after the Turn may have begun is not replayed" are compatible with the narrowed `pre_start`.
- No document still recommends `OPENCODE_CONFIG_CONTENT` or the instructions API.

## Checks

- `git diff --check` returned 0.
- `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md` printed nothing. Its return code of 1 only means a diff exists.
- Redaction grep over the spike doc, the fix2 handoff, and tasks 0050 to 0056 looked for full `ses_`/`msg_`/`prt_` IDs, `/Users/`, the username, `/var/folders`, `/private/`, email addresses, `sk-` keys, `Bearer`, API keys, and `token=`. The only hit was the fix2 handoff's own description of the grep, which is a false positive. The result is clean.
- `git status --short src/` is empty.
- No CLI runs, no edits beyond this handoff, no task status change, and no commit.

## Next

The manager can mark task-0050 `done` and unblock the next selected dependent task. Leave the I1 to I3 wording to the planner's discretion.
