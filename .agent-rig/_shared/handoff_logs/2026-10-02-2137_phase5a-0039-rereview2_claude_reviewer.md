---
agent: reviewer
role: reviewer
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: done
---

# task-0039 re-review 2 (after fix round 2)

Inputs:
- the re-review handoff `2026-10-02-2135_phase5a-0039-rereview_claude_reviewer.md`;
- the fix handoff `2026-10-02-2136_phase5a-0039-fix2_claude_worker.md`;
- `docs/phase-5a-claude-cli-spike.md`;
- tasks 0039, 0042, 0044, 0046, and 0048;
- `docs/implementation-phases.md` Phase 5a;
- proposal `:93` and `:96`;
- ADRs 0007 and 0008, and plan-review decision 28.

I ran no CLI commands, made no edits apart from this handoff, and did not change any task status.

Verdict: **clean.** Both findings are resolved, and I found no new contradictions.

## Prior findings

- **A (resolved).** The spike now refuses on the presence of `CLAUDE_CODE_OAUTH_TOKEN` in the environment. It checks presence only and never reads, prints, or strips the value.
  - Spike `:94`, `:148`, and `:155` say this, and they agree with task-0044 Scope `:31-32`.
  - `:94` explains why the field checks alone are not enough.
  - Task-0044 `:34` ("never strip environment variables") is consistent with this.
  - This matches D3, Phase 5a task 7 (`implementation-phases.md` Phase 5a list item 7), the test scenario that names `CLAUDE_CODE_OAUTH_TOKEN`, and proposal `:96`.
- **B (resolved).** The spike now labels the effect of `--system-prompt-snapshot off` as "inferred from `--help` and the binary, not exercised" (`:52`), and repeats this at `:146`.
  - Task-0042 Scope `:36` adds a one-time real-CLI check in a disposable temp project, with the result recorded in the handoff. It includes the rule "If it does not, stop and report to the planner."
  - This is consistent with task-0042 `:32`, Phase 5a task 4, and proposal `:93`.

## Nits and residual risk (non-blocking)

- Spike `:89` still says "The guard does not need it: it refuses every value other than `claude.ai` (see below)." Read alone, this undersells why the extra presence check exists, but the "(see below)" pointer leads to `:94`, which states the full rule. Wording only, so I am not raising it as a finding.
- The presence check covers only the inherited process environment. If a token were supplied some other way that the guard does not inspect (for example, an `env` block in the owner's Claude settings, which task-0044 forbids reading), detection would fall back to the `auth status` and init `apiKeySource` fields. Task-0044's fake-CLI tests should therefore include an `oauth_token` `authMethod` fixture. That is already covered by "Refuse everything else" and "tests ... for each accepted and refused source".

## Checks

- **Contradictions.** None with Phase 5a docs, ADRs 0007/0008, or tasks 0042, 0044, 0046, and 0048.
- **Redaction.** I grepped the spike, the fix handoff, and tasks 0039, 0042, and 0044 for `@`, UUID patterns, `sk-` tokens (excluding `task-` IDs), and `/Users/`. Nothing matched.
- **Git.**
  - `git diff --check` is clean.
  - The untracked files have no trailing whitespace.
  - `git status --porcelain src/` is empty, so there are no `src/` changes.
  - Task-0039 remains `status: review`. Nothing has been committed.

## Next

Manager or planner: task-0039 can be marked `done`. Tasks 0042 and 0044 already carry findings B and A.
