---
agent: worker
role: worker
tool: claude
task: task-0051
task_title: "Phase 5b: OpenCode provider configuration and wiring"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0051 worker handoff

## Summary

- `src/config.ts`: `AGENT_PROVIDER` accepts `codex`, `claude`, or `opencode`; unsupported values fail with `AGENT_PROVIDER must be codex, claude, or opencode`. `Configuration["agentProvider"]` is `"codex" | "claude" | "opencode"`. No model, permission, sandbox, approval, or credential keys added; `CLAUDE_MODEL` remains parsed only for Claude homes.
- `src/conversation-worker.ts`: the fixed display map gains `opencode`. The map values now carry their article (`a Codex`, `a Claude`, `an OpenCode`) so the notice reads "an OpenCode session" instead of "a OpenCode session". Codex/Claude notice text is byte-identical; unknown stored values still produce the generic text, never echoed.
- `src/index.ts`: `case "opencode"` throws `OpenCode runtime is not implemented yet` inside the existing try, so the catch releases the runtime lock; `probeConcurrency` stays `async () => false`. Task-0052 replaces the throw.
- `README.md`: validate sentence lists `opencode` and says it does not contact OpenCode. `.env.sample` and the proposal `.env.sample` block do not enumerate providers, so they are unchanged.

## Tests (122 -> 125; `grep -c '^test('` matches the runner count)

- `src/test/config.test.ts`: the existing unsupported-provider assertion now loops over `other`, `OpenCode`, `opencode ` (case and trailing-space variants) and expects the three-provider message; new test "accepts the OpenCode provider without a model setting" (also shows `CLAUDE_MODEL` is ignored for OpenCode).
- `src/test/conversation-worker.test.ts`: new test covering opencode-bound threads in codex and claude homes, and codex/claude-bound threads in an opencode home; no runtime call, failure detail `Agent provider mismatch; replay_safe=false`, exact notice text.
- `src/test/transport.test.ts`: new test "OpenCode selection fails before any external connection and releases the runtime lock": temp runtime home, PATH set to the temp dir, temp HOME; asserts the rejection message, no Discord `login`, lock file gone, and a fresh `start()` succeeds. PATH/HOME restored (deleted when originally unset), cwd restored.

## Verification

- `npm test`: 125 tests, 125 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean (no new untracked source files)

## Notes for reviewer

- The article change in the display map is a small addition beyond the literal scope, made to avoid shipping "a OpenCode session". Existing Codex/Claude notice assertions pass unchanged.
- Other modified/untracked files (AGENTS.md, docs, other README hunks, task/ADR/spike files) predate this task and were not touched.
