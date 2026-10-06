---
agent: worker
role: worker
tool: claude
task: task-0040
task_title: "Phase 5a: Claude provider configuration"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0040 worker fix handoff (F1)

Read: reviewer handoff `2026-10-02-2146_phase5a-0040_claude_reviewer.md`, prior worker handoff `2026-10-02-2145_phase5a-0040_claude_worker.md`, task file.

## Change

- `src/config.ts:42`: `CLAUDE_MODEL` regex is now `^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$`. The first character must be a letter or digit, so option-like values (`--dangerously-skip-permissions`, `-p`, `--settings`) fail validation.
- `src/config.ts:43`: message is now "CLAUDE_MODEL must start with a letter or digit and contain only letters, digits, and . _ : - [ ]".
- `src/test/config.test.ts:63`: the accepted list now also covers `opus`, `haiku`, `claude-opus-5-5`, `claude-sonnet-5-5[1m]`.
- `src/test/config.test.ts:69`: added `--dangerously-skip-permissions`, `-p`, `--settings` to the rejection list.
- `src/test/config.test.ts:72`: the assertion matches the new message.

Both judgment calls stay unchanged, as the reviewer recommended: the "AGENT_PROVIDER must be codex or claude" message, and `CLAUDE_MODEL` is ignored in a Codex home. No docs quote the regex or message, so no doc edits were needed.

## Checks

- `npm test`: 89 tests, 89 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- I did not run `validate` in the repo root, and no `.inoai-connect*/.env` was read.

## Next

Re-review task-0040. For task-0042, as defense in depth, pass the model as a separate argv element after `--model` (or as `--model=<value>`), never through a shell.
