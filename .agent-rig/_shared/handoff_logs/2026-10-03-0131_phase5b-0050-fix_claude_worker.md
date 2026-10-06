---
agent: worker
role: worker
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Handoff: task-0050 review fixes

## Result

I fixed only `docs/phase-5b-opencode-cli-spike.md`. There were no CLI runs and no `src/` changes, and nothing is committed. Redaction is unchanged. The task is now in `review`.

## Findings and fixes

1. **`pre_start` consistency** (Medium). The table rows at :154-155 and the rule at :162 now agree:
   - `pre_start` applies only to a spawn failure, or a non-zero exit with zero parsed stdout events.
   - Any event carrying a `sessionID` means the Turn started, so it is not replay-safe.
   - An existence-check exit 1 without `SessionNotFoundError` maps to `pre_start`.
   - The session flow is at :135-140. The existence check runs only for a session this process has not yet seen succeed, for example after a restart. This mirrors the Claude adapter's in-memory persisted state.
2. **Count only** (Medium). The denial notes at :93 and :163 no longer mention tool names. The Event is `denials=<n>`.
3. **Single count source** (Low/med). See :94 and :163. The count is the number of stdout `tool_use` events with `state.status:"error"` and the fixed prefix. stderr lines are never added. My evidence does not show whether the `external_directory` rejection produced its own stdout event, so whether the stdout and stderr counts matched is **unknown** (:95, open question :171). Task-0053 should verify it with a fake-CLI test and one real check.
4. **Persona D1** (Low). The D1 note is at :62. The persona implication at :141-149 replaces the earlier options and lists the planner-updated docs: implementation-phases :201/:214, proposal :104, plan-review 29, and the task-0052 Persona bullet. I removed the stale `POST /api/session` open question.
5. **Free-tier risk** (Low). The note at :164 recommends a README mention (task-0054) and an OpenCode `authentication` notice worded to cover a free-tier refusal.
6. **Answer assembly** (Low). See :134. The answer is the final-step `text` events (those after the last `step_start`) joined with "\n\n". The evidence fits this rule. Interim text inside a tool step was not specifically captured, so task-0052 should add a fake-CLI test for it.

## Checks

- `git diff --check` is clean.
- `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md` reports no whitespace errors.
- A grep of the doc found no unredacted IDs or local paths.

## Suggested skills

- `code-review` (re-review)
