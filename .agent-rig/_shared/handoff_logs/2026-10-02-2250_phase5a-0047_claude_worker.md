---
agent: worker
role: worker
tool: claude
task: task-0047
task_title: "Phase 5a: README Claude setup"
status: handoff
---

# task-0047 worker handoff

## Change

Docs-only. Added `## Claude runtime` to `README.md`, between `## Development` and `## Documentation`, with these subsections:

- Prerequisites: Node 22+, `claude` installed and signed in (`claude`, then `/login`), and one Discord bot per instance.
- Setup: `npm run validate -- --connect-dir .inoai-connect-claude`, copy `.env.sample`, set `AGENT_PROVIDER=claude`, validate, then `npm start -- --connect-dir .inoai-connect-claude`. Covers the `CLAUDE_MODEL` format rule (Codex homes ignore it) and the fact that validate is offline, so the guard first runs at start.
- Credential guard: the accepted source and the refused ones (API key/Console key, auth token or Anthropic profile, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`, cloud provider or gateway). Explains the per-Turn `apiKeySource` check, which produces the `claude /login` notice, and how to fix a refusal.
- Subscription login policy: paraphrases Anthropic's Agent SDK note, links https://code.claude.com/docs/en/agent-sdk/overview, and says inoai offers no login.
- Behavior: fail-closed permission notice (ADR 0007), `CLAUDE.md` and not `AGENTS.md`, `agent.md` changes apply on the next Turn, the two-`haiku`-call probe with global FIFO fallback, and the provider-mismatch and missing-session notices that point to `/inoai reset`.
- Running alongside Codex: a separate bot per concurrently running instance. Reusing one token is safe only when one instance runs at a time.

Existing README lines (Status, V1 in brief, Deployment layout, validate description) were already accurate for Phase 5a, so I left them unchanged. No Claude-deferred or Codex-only `AGENT_PROVIDER` wording remains.

## Verification

- `git diff --check README.md` is clean.
- Commands and keys were checked against `package.json` (`validate`, `start`), `src/index.ts` (`--connect-dir`, probe fallback log), `src/config.ts` (`AGENT_PROVIDER`, `CLAUDE_MODEL` regex), `src/claude-runtime.ts` (`auth status --json`, refusal labels, `loginHint = "claude /login"`, per-Turn `credentialRefused`, `--permission-prompts none`), `src/concurrency-probe.ts` (`--model=haiku`, `--tools ""`), `src/runtime-turn.ts` and `src/conversation-worker.ts` (reset notices), `src/approval-relay.ts` (Claude denial notice), and `src/transport.ts` (`reset` subcommand).
- All relative links resolve (ADR 0007, ADR 0008, and the existing doc links). The in-page anchor `#running-alongside-codex` matches its heading.
- No `.inoai-connect*/.env` was read. No secrets or real IDs are included.

## Suggested skills

- `code-review` for the reviewer pass, if wanted. Otherwise review the README diff against the sources above.
