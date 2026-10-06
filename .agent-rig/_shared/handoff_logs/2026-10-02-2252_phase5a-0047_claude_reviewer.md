---
agent: reviewer
role: reviewer
tool: claude
task: task-0047
task_title: "Phase 5a: README Claude setup"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0047 reviewer handoff

## Verdict

Nearly clean. One low-severity accuracy finding. No other drift found.

## Findings

1. **Low, README.md:179.** The text says "The notice asks you to run `/inoai reset` or start a new thread" and applies that to both cases. Only the provider-mismatch notice (`src/conversation-worker.ts:21`) mentions a new thread. The missing-session notice (`src/runtime-turn.ts:20`) says only "Use /inoai reset to start a new session." Suggested fix: "A thread started under a different provider is not resumed, and its notice offers `/inoai reset` or a new thread. If the thread's Claude session can no longer be found, the notice asks you to run `/inoai reset`." Any wording works if it stops attributing the new-thread option to the missing-session notice.

## Verified (no issues)

- Commands: `npm run validate -- --connect-dir`, `npm start -- --connect-dir`, and `cp .env.sample` match `package.json` scripts and `src/index.ts`. `.env.sample` already contains `AGENT_PROVIDER` and `CLAUDE_MODEL=`.
- Bootstrap order works for a fresh home. `src/runtime-home.ts` creates `.env`, `agent.md`, and `inoai.sqlite` with `wx`. Validate is offline, and the guard runs in `ClaudeRuntime.connect` at start.
- `CLAUDE_MODEL` rule and "Codex homes ignore it" match `src/config.ts:41-43`.
- Credential guard: `claude auth status --json`, the `CLAUDE_CODE_OAUTH_TOKEN` presence check, and the refusal categories (API key/Console key, auth token or Anthropic profile, apiKeyHelper, cloud provider/gateway) match `src/claude-runtime.ts:57-62, 262-281`. Per Turn, a non-`none` `apiKeySource` on init leads to an authentication failure and the `claude /login` notice (`src/runtime-turn.ts:14`).
- Permission behavior: `--permission-prompts none` and the Claude denial notice (`src/approval-relay.ts:51`) match README:175 and ADR 0007.
- `agent.md` is re-read on every Turn (`src/agent-session.ts`, `conversation-worker.ts:154-155`) and passed through `--append-system-prompt` with the snapshot off.
- Probe: two `--model=haiku` calls with `--tools ""` in a `mkdtemp` folder. When it fails, the worker falls back to global FIFO, and the mode is logged at `src/index.ts:415`.
- Policy note: compared against the live https://code.claude.com/docs/en/agent-sdk/overview note ("Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products..."). The paraphrase is accurate and makes no legal claim beyond "inoai offers no login."
- Consistent with the status line, deployment layout, Agent Instances, the proposal's Claude section, Phase 5a, and AGENTS.md. No stale "Claude deferred" wording. ADR links and `#running-alongside-codex` resolve. No secrets or real IDs.
- `git diff --check` is clean. No `.inoai-connect*/.env` was read.

## Next

A worker applies the one-line fix to README.md:179, then a quick re-review.

## Suggested skills

None required.
