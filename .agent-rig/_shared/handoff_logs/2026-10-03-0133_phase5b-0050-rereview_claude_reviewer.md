---
agent: reviewer
role: reviewer
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Re-review: task-0050 OpenCode headless contract spike (after doc fix round)

## Verdict

Not clean yet. All six prior findings are addressed as worded. The doc now agrees with the planner's D1 updates (implementation-phases :201/:214, proposal :104, plan-review 29, task-0052 Persona bullet).

One medium issue remains, and it comes from the `pre_start` rule I recommended last round. Read against the spike's own evidence, that rule is not "proven safe" under ADR 0002. It also has no precedence order. Fix it before `done`. The other items are low, and most are stale wording in downstream task files that only the planner can fix.

## Prior findings

1. `pre_start` consistency: the table (:154-155) and the rule (:162) now agree. The existence-check exit 1 without `SessionNotFoundError` maps to `pre_start` (:138, :155). **Resolved as worded**, but see new finding N1.
2. Count only: :93 and :163 now say count only, with no tool names. This matches task-0053. **Resolved.**
3. Single count source: :94 and :163 count stdout events only and never add stderr lines. The stdout/stderr match is marked unknown (:95, :171). **Resolved.**
4. Persona D1: :62 and :141-147 record D1 and list the updated docs. **Resolved.** (Residue: see N2.)
5. Free-tier risk: :164. **Resolved in the spike.** task-0054 has not picked it up (see N4).
6. Answer rule: :134 uses final-step `text` events (after the last `step_start`) joined with "\n\n", and a fake-CLI test is required. **Resolved.**

## New findings

N1. **Medium: "non-zero exit with zero parsed stdout events → `pre_start` (replay-safe)" is not proven safe, and precedence is missing** (`docs/phase-5b-opencode-cli-spike.md:154`, `:162`).
- The rule's premise is contradicted by the spike's own evidence:
  - Events are emitted only per *completed* part, and `step_start` arrives with the finished text (:27).
  - The session and user message are persisted about 0.3 s after spawn, but the first stdout event comes at 1.0-4.1 s (:125).
  - The free-tier sample shows the user message stored before any step (:162).
- So a process that dies or is killed in that window has zero events, yet it has already recorded the user message. In a tool step, it may also have run a tool whose `tool_use` event had not been emitted yet.
- Replaying it would duplicate the message and could duplicate side effects. ADR 0002 permits retry only when the Turn "never started or the runtime proves it had no side effects".
- The table also gives no precedence. A `/inoai cancel` or an idle timeout before the first event is both `cancelled`/`timed_out` and "non-zero exit, zero events". Read literally, the table would make a cancelled Turn replay-safe.
- In the Claude adapter (`src/claude-runtime.ts:110-116`), `timed_out` and then `cancelled` are checked before `!started → pre_start`. Its `started` signal is an init event emitted before any model or tool work, and OpenCode has no equivalent.
- Fix:
  - Make replay-safe `pre_start` only a spawn failure (ENOENT/EACCES) or an existence-check failure without `SessionNotFoundError`.
  - Classify any other non-zero exit or signal as `uncertain`, even with zero stdout events.
  - Alternatively, allow `pre_start` only for a narrowly proven case, for example exit 1 before the ~0.25 s session-creation point, and state that the evidence for it is thin.
  - State the precedence explicitly: spawn failure, then `timed_out`, then `cancelled` (cancel requested), then `pre_start`, then `uncertain`, mirroring Claude.
  - Note that this departs from the Claude "no init → pre_start" precedent because OpenCode has no early start event.
- If task-0052 implements the current wording, retries can duplicate side effects.

N2. **Low: a stale fallback paragraph contradicts D1** (`docs/phase-5b-opencode-cli-spike.md:80`). It still describes "the planned fallback: prepend a delimited persona block to the first Turn's prompt, then PUT the entry". D1 prepends on *every* Turn and uses no instructions API. The note at :62 mitigates this, but a worker who jumps to §3 could misread it. Fix: prefix the paragraph with "Superseded by D1 (see Implications):", or cut the fallback sentence.

N3. **Low (planner, task-0052): a stale test item** (`.agent-rig/_shared/tasks/task-0052_phase-5b-opencode-runtime-adapter.md:37`). It says "persona env". Under D1 the persona is a stdin prompt block, and the scope (same file) says not to alter the environment. Fix: "persona prompt block on every Turn (re-read after an edit) and an unchanged environment". Also add the spike's two requested fake-CLI tests: interim tool-step text is excluded from the answer, and a resume is checked only once per process.

N4. **Low (planner, task-0054): stale persona wording, and the free-tier note is missing** (`.agent-rig/_shared/tasks/task-0054_phase-5b-readme-opencode-setup.md:33`). It says "`agent.md` via instructions", which contradicts D1. Fix: "`agent.md` as a delimited block prepended to each Turn's prompt". Also add the spike's :164 free-tier refusal risk to the Data and billing bullet.

N5. **Low (planner, task-0053): the denial signal is ambiguous** (`.agent-rig/_shared/tasks/task-0053_phase-5b-fail-closed-opencode-permission-denials.md:30`). "stdout event and/or stderr line" leaves room to count stderr, or to sum both sources. Fix: "stdout `tool_use` error events with the fixed prefix only (spike §4 and Implications). stderr lines are never counted or stored." Keep the existing instruction to verify stdout/stderr parity with one real check.

N6. **Info: the existence-check scope is worded differently in two places.** `docs/implementation-phases.md:201` reads as checking before every resume. The spike (:135) and task-0052 limit the check to a session not yet seen to succeed in this process, for example after a restart. These are compatible, and the narrower rule governs. Optionally align :201. One residual ambiguity for task-0052: does a `sessionID` streamed by a first Turn that then failed or was uncertain get stored, and does the next Turn check it? The "not yet seen to succeed" rule implies yes, it is checked. That is the safe reading.

## Checks

- Redaction: I grepped the spike doc, the fix handoff, and the task file for full `ses_`/`msg_`/`prt_` IDs, `/Users/`, the username, `/var/folders`, `/private/`, emails, `sk-`, `Bearer`, api keys, and `token=`. The only hits were false positives: `task-0053` matched `sk-`, and token counts. Clean.
- `git diff --check` is clean (rc 0).
- `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md` printed no output. rc 1 only reflects that a diff exists.
- `git status --short src/` is empty, so there are no `src/` changes.
- I made no CLI runs, did not change the task status, and committed nothing.

## Next

Send the task back to the worker for a doc-only fix of N1 (required) and N2 (recommended) in the spike doc. The planner fixes N3-N5 in the task files. After that, a quick re-review should be enough.
