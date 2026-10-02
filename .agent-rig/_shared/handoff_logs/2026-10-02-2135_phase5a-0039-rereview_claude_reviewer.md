---
agent: reviewer
role: reviewer
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: handoff
---

# task-0039 re-review handoff (after fix round)

I re-reviewed `docs/phase-5a-claude-cli-spike.md` after the fix worker's round (`2026-10-02-2133_phase5a-0039-fix_claude_worker.md`). I checked it against task-0039, the earlier reviewer handoff (`2026-10-02-2059_...`), the Phase 5a section of `docs/implementation-phases.md` (lines 151-189), the proposal's "Claude runtime (Phase 5a)" section (`docs/discord-codex-cli-harness-proposal.md:91-99`), ADRs 0007 and 0008, tasks 0042, 0044, and 0046, and owner decisions D1-D3. I ran no CLI commands, made no edits apart from this handoff, and did not change any task status.

Verdict: **findings, low only.** All four earlier findings are resolved, and I found no regressions. Two new low findings remain. Both are residual claims that the evidence does not support. They do not block closing the spike. The planner should carry them into tasks 0044 and 0042 rather than reopen the spike.

## Prior findings

1. **Medium (credential guard and `CLAUDE_CODE_OAUTH_TOKEN`): resolved by D3.**
   - Spike `:89`, `:94`, `:148`, and `:155` now accept only `authMethod:"claude.ai"` and refuse `CLAUDE_CODE_OAUTH_TOKEN`. The token's report value is marked unverified.
   - This matches task-0044 Scope `:31`, implementation-phases Phase 5a task 7 and its test scenario (`docs/implementation-phases.md:179`), and proposal `:96`. See new finding A for one remaining overclaim.
2. **Low (snapshot): resolved by D1.**
   - Spike `:52` and `:146` say `--system-prompt-snapshot off` is passed on every Turn.
   - This matches Phase 5a task 4 (`implementation-phases.md:162`), task-0042 Scope `:32`, and proposal `:93`. See new finding B on verification.
3. **Low (`aborted_streaming` without a cancel): resolved.**
   - Spike `:126` classifies Turns from the `result` event.
   - The row at `:134` maps an interrupt with no cancel to `uncertain`, not replay-safe.
   - This matches task-0042 Scope `:33` and ADR 0002.
4. **Low (probe leftovers): resolved.**
   - Spike `:142` and `:149` say the probe verifies, then deletes, its own encoded-cwd folder by literal path. The tools-disable flag is handed to task-0046.
   - This matches task-0046 Scope `:32-33` and does not conflict with its "no files outside its temporary project" acceptance criterion, because the folder is removed.

D2: spike `:76` and `:147` match ADR 0007, Phase 5a task 4, and task-0042 `:32`, all of which treat the flag as "restricting only".

## New findings

A. **Low: the guard claims it refuses `CLAUDE_CODE_OAUTH_TOKEN` "whatever `authMethod` it reports", but it has no mechanism to do that.** `docs/phase-5a-claude-cli-spike.md:94`, `:155`.
   - The proposed guard checks only `auth status` fields: `authMethod === "claude.ai"`, `firstParty`, and no `apiKeySource`, plus init `apiKeySource`.
   - The doc says itself (`:89`) that what a setup token reports is unverified. If that token reports `authMethod:"claude.ai"` with no API-key source, the field check would accept it.
   - That would contradict D3 and the Phase 5a test scenario that requires refusing it and naming the source (`implementation-phases.md:179`).
   - The bundle's `oauth_token` enum value makes the field check likely to work, but it is not proven. The open question at `:155` ("does not block the guard") holds only if `oauth_token` is what the token reports.
   - Suggested carry-forward to task-0044: either confirm the reported `authMethod` for a setup token with owner-run evidence, or have the guard also refuse when the inherited environment contains `CLAUDE_CODE_OAUTH_TOKEN`. The second option checks the variable's presence only, never its value, and needs no stripping. That fits task-0044's "never strip environment variables" and "do not read credential files".
B. **Low: the effect of `--system-prompt-snapshot off` was not exercised.** `docs/phase-5a-claude-cli-spike.md:52`, `:146`.
   - The spike observed only the default `on` behavior (resuming with QUOKKA-7 still produced ZEBRA-42). The first worker handoff (`2026-10-02-2056_...:22`, `:46`) shows no run with `off`.
   - The doc states as fact that `off` makes `agent.md` edits reach existing Sessions. That is an inference.
   - Suggested carry-forward: label it "inferred, not exercised" in the spike, or add a check to task-0042 or the live smoke task-0048 that a changed append text takes effect on `--resume` with `off`. This is the Phase 5a scenario "`agent.md` reaches every Turn" (`implementation-phases.md:181`).

## Checklist

- **Scope coverage.** Every task-0039 scope bullet is still answered or explicitly unknown:
  - event shapes (§1), session-id, resume, and unknown resume (§2), append prompt and model (§3), denials (§4), credential source (§5), SIGINT (§6);
  - auth and usage failures (§7): expired auth and usage limit are explicit unknowns;
  - persistence and storage location (§8);
  - the CLI version is at `:4`.
- **Redaction.** I grepped the spike doc and the fix handoff for `@`, UUID patterns, `sk-` tokens, and `/Users/`. Nothing matched. The only hits from a 32+ character token pattern are hyphenated filenames and prose, which are false positives. Identity fields are `<redacted>`, and tool IDs are `toolu_<redacted>`.
- **Git.**
  - `git diff --check` is clean, and the untracked spike doc has no trailing whitespace or tabs.
  - `git diff --stat -- src/` is empty, so there are no `src/` changes.
  - Task-0039 still has `status: review`. This reviewer did not change it.

## Next

Manager or planner: findings A and B are low and can go into task-0044 and task-0042/0048 as notes. If the planner accepts that, task-0039 can be marked `done`. Otherwise, send them back for a one-line wording fix in the spike, marking both claims as unverified. Nothing has been committed.
