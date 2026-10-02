---
id: task-0044
title: "Phase 5a: Claude subscription credential guard"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0042
message: Subscription-only credential guard at startup and per Turn; review
  clean, 113 tests
---




# Task

## Context

With `-p`, API keys, auth tokens, `apiKeyHelper`, cloud-provider variables, and Anthropic profiles outrank the owner's subscription `/login`, and a present key is always used. Codex startup already requires ChatGPT sign-in with no API key.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Refuse to start a Claude Agent Instance unless the CLI will use the owner's subscription credential.

## Scope

- Ask the CLI which credential source it will use, using the mechanism verified by the spike; do not read credential files or settings directly.
- Accept only the interactive subscription `/login`: `claude auth status --json` must report logged in, `authMethod` `claude.ai`, first-party provider, and no API-key source, and each Turn's init `apiKeySource` must be `none` (else fail before the Turn starts). Refuse everything else, including `CLAUDE_CODE_OAUTH_TOKEN`, discarding email and organization fields; otherwise refuse before Discord starts with a local message naming the overriding source (never its value).
- Also refuse when `CLAUDE_CODE_OAUTH_TOKEN` is present in the environment, checking presence only (never reading, printing, or stripping its value), because what `claude auth status` reports for it is unverified (spike review finding A).
- Report expired or missing login as an authentication failure with the Claude login hint.
- Never modify the owner's shell, settings, or credentials, and never strip environment variables.
- Add a `run()` startup test with a fake `claude` on PATH (answering `--version` and `auth status --json`) and a supplied transport, covering both guard refusal and a successful start whose denied Turn posts the task-0043 notice (task-0043 review note: Claude wiring otherwise covered only by typecheck).
- Tests with a fake CLI for each accepted and refused source. Include an `authMethod: "oauth_token"` fixture with no `CLAUDE_CODE_OAUTH_TOKEN` in the environment (a token supplied through the owner's settings `env` block) and a per-Turn init `apiKeySource` other than `none`.

## Planner Notes

Runs only for `AGENT_PROVIDER=claude`. The check must not print or persist secret values.

## Implementation Plan

1. Implement the startup check → verify: fake-CLI tests per source.
2. Wire it before transport start → verify: full checks.

## Acceptance Criteria

- [ ] Startup succeeds for subscription login and refuses, naming the source, for each overriding credential.
- [ ] No credential value is printed, logged, or persisted.
- [ ] The owner's configuration is never modified.

## Notes

- 2026-10-02 worker: `ClaudeRuntime.connect()` now runs `--version`, then refuses when `CLAUDE_CODE_OAUTH_TOKEN` is present in `process.env` (an `in` check, so presence only), then runs `claude auth status --json` with no shell, stdin and stderr ignored, a 10 s timeout, and a 64 KiB cap. Only `loggedIn`/`authMethod`/`apiProvider`/`apiKeySource` are kept, and parse errors are replaced with a fixed message.
  - Refusal order: any `apiKeySource` key, then a non-`firstParty` provider, then an `authMethod` other than `claude.ai`/`none`. A refusal names only a fixed category label. `loggedIn !== true` or `authMethod: "none"` gives "sign-in is required; run claude /login locally". Unparsable output or a nonzero exit is refused as "could not be verified".
  - Per Turn: an init `apiKeySource !== "none"` (including a missing one) kills the CLI with SIGKILL, ignores the rest of the stream, and fails as `authentication`, not replay-safe.
  - `run()` already releases the lock when `connect()` throws.
  - Tests: per-source fixtures, the env-presence check, the per-Turn kill, and two `run()` tests with a fake `claude` on PATH (refusal; successful start with the denied-Turn notice).
  - Checks: npm test 113/113. Typecheck, build, and diff checks are clean. Against the real CLI the guard only printed "accepted".
