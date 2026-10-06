---
agent: worker
role: worker
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0039 worker handoff (review fixes)

Applied the reviewer findings from `2026-10-02-2059_phase5a-0039_claude_reviewer.md` and the owner decisions D1-D3 recorded by the planner. Only `docs/phase-5a-claude-cli-spike.md` changed, plus a task Notes line. I ran no new CLI commands and made no `src/` changes.

## Findings and fixes

1. **Medium: the credential guard conflicted with `CLAUDE_CODE_OAUTH_TOKEN`.** This is resolved by D3, which accepts only the interactive `/login`.
   - `docs/phase-5a-claude-cli-spike.md:89`: the `authMethod` list no longer glosses `oauth_token`. It says only `claude.ai` was observed and that the setup-token report value is unverified. It also says the guard refuses that token whatever it reports.
   - `:94`: the guard is now labelled D3. It explicitly refuses `CLAUDE_CODE_OAUTH_TOKEN` and never accepts any `oauth_token` value.
   - `:148` (Implications) and `:155` (Open questions) repeat this. The open question is marked as not blocking the guard.
2. **Low: the system-prompt snapshot caveat.** This is resolved by D1. At `:52` the caveat and its ZEBRA-42/QUOKKA-7 evidence are kept, followed by a "Resolved" note: the adapter passes `--system-prompt-snapshot off` on every Turn. `:146` was updated to match.
3. **Low: `aborted_streaming` without a cancel was unmapped.**
   - `:127`: the text now says Turns are classified from the `result` event, never from the exit code, with the SIGINT exit 0 and not-logged-in exit 1 cases as evidence.
   - `:134`: a new row maps `aborted_streaming` with no cancel requested (shutdown, an external signal, or process loss) to `uncertain`, not replay-safe per ADR 0002.
   - `:146`: Implications repeats it.
4. **Low: the probe leaves a project folder behind.**
   - `:142` records that `--no-session-persistence` still creates `~/.claude/projects/<encoded-cwd>/memory/`. The probe (task-0046) must verify that the folder holds only its own empty artifacts, then delete that exact folder by literal path. The tools-disable flag is left for task-0046 to confirm.
   - `:149` and `:156` repeat this.
5. **D2.** `:76` now records `--permission-prompts none` as decided, and as restricting only. `:147` cites D2.

## Checks

- `git diff --check` is clean.
- A trailing-whitespace and tab grep on the untracked spike doc is clean.
- A redaction grep (`@`, UUID pattern, `sk-<token>`, `/Users/`) on the spike doc found nothing.
- `agent-rig tasks set-status task-0039 review` returned `status=review`.

## Next

The reviewer should re-review `docs/phase-5a-claude-cli-spike.md`. Nothing has been committed.
