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

# task-0040 worker handoff

## Summary

- `AGENT_PROVIDER` accepts `codex` or `claude`; unsupported values fail with `AGENT_PROVIDER must be codex or claude` (same style as before, message now lists both).
- Optional `CLAUDE_MODEL`: blank or absent means the CLI default (`claudeModel` omitted). For a Claude home, a non-blank value must match `^[A-Za-z0-9._:\-\[\]]+$` (covers aliases, dated IDs, `[1m]` suffixes, Bedrock-style `us.anthropic.*`), otherwise `CLAUDE_MODEL must contain only letters, digits, and . _ : - [ ]`.
- For a Codex home `CLAUDE_MODEL` is ignored entirely (not validated, not exposed).
- `Configuration` gains `agentProvider: "codex" | "claude"` and `claudeModel?: string`.
- `run()` in `src/index.ts` throws `Claude runtime is not implemented yet` before connecting the Codex app server when `claude` is selected and no runtime was supplied; the existing catch releases the runtime lock. Tasks 0041/0042 replace this.
- No permission, sandbox, approval, or credential keys were added.

## Changed files

- `src/config.ts`
- `src/index.ts` (one guard line)
- `src/test/config.test.ts` (3 tests: Claude accepted with blank/valid model; malformed model and unsupported provider rejected by name; `CLAUDE_MODEL` ignored for Codex)
- `.env.sample` (`CLAUDE_MODEL=`)
- `docs/discord-codex-cli-harness-proposal.md` (`.env.sample` block only)
- `README.md` (the `npm run validate` sentence)

Other modified/untracked files in the tree (AGENTS.md, docs/implementation-phases.md, docs/plan-review.md, ADRs, spike doc, other README/proposal hunks) predate this task and were not touched.

## Verification

- `npm ci` (node_modules was absent) - ok
- `npm test` - 89 tests, 89 pass, 0 fail
- `npm run typecheck` - clean
- `npm run build` - clean
- `git diff --check` - clean
- Manual `node dist/index.js validate` in a scratchpad temp deployment folder: `AGENT_PROVIDER=claude` with blank `CLAUDE_MODEL` reported valid; `CLAUDE_MODEL=opus;x` failed with the `CLAUDE_MODEL` message. Temp folder removed; repository-root `.inoai-connect*` untouched.

## Notes for reviewer

- Choosing to skip validation of `CLAUDE_MODEL` for Codex homes is my reading of "Ignore `CLAUDE_MODEL` for a Codex home"; flag it if a malformed value should fail regardless of provider.
