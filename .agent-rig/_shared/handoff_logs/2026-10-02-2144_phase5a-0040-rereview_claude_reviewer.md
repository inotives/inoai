---
agent: reviewer
role: reviewer
tool: claude
task: task-0040
task_title: "Phase 5a: Claude provider configuration"
status: done
---

# task-0040 re-review handoff (after F1 fix)

Read: reviewer instructions, task file, reviewer handoff `2026-10-02-2146_phase5a-0040_claude_reviewer.md`, fix handoff `2026-10-02-2150_phase5a-0040-fix_claude_worker.md`, and the current diff of `src/config.ts`, `src/index.ts`, `src/test/config.test.ts`. No implementation edits made. (This file's timestamp is the local clock at the time of review. It sorts before the earlier handoffs because those used a later clock.)

## Verdict

Clean. F1 is fixed and nothing regressed.

## F1 verification

- `src/config.ts:42`: the regex is now `^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$`. The first character must be a letter or digit.
- `src/config.ts:43`: the message now reads "CLAUDE_MODEL must start with a letter or digit and contain only letters, digits, and . _ : - [ ]".
- Direct regex probe: `-`, `-p`, `--settings`, and `--dangerously-skip-permissions` are rejected. `opus`, `sonnet`, `haiku`, `claude-opus-5-5`, and `claude-sonnet-5-5[1m]` are accepted.
- `src/test/config.test.ts:63`: the accepted list covers all of the realistic IDs above. `src/test/config.test.ts:69`: the rejection list includes `--dangerously-skip-permissions`, `-p`, and `--settings`. The assertion matches the new message.
- Scope: compared with the first review, only the regex, the message, and the test lists and assertion changed. `src/index.ts` still has only the one-line Claude guard. The rest of the task-0040 diff (types, provider check, Codex-home ignore, `claudeModel` exposure) is unchanged.

## Checks

- `npm test`: 89 tests, 89 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- `node dist/index.js validate` in a scratchpad temp deployment folder, which was removed afterwards. I did not read or touch the repo-root `.inoai-connect*` or `.env`.
  - `AGENT_PROVIDER=claude` with `CLAUDE_MODEL` set to blank, `opus`, or `claude-sonnet-5-5[1m]`: valid
  - `--dangerously-skip-permissions`, `-p`, or `-`: rejected with the `CLAUDE_MODEL` message
  - `AGENT_PROVIDER=codex` with `CLAUDE_MODEL=-p`: valid, because the model is ignored in a Codex home. This is the intended behavior.

## Residual risk (non-blocking, carried forward)

- No test covers the temporary `run()` Claude guard or lock release. Tasks 0041 and 0042 replace that guard.
- For task-0042, as defense in depth, pass the model as a separate argv element after `--model` (or as `--model=<value>`), never through a shell.

## Next

The planner can mark task-0040 `done` and unblock the next selected dependent task.
