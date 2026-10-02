---
id: task-0047
title: "Phase 5a: README Claude setup"
type: doc
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0044
message: README Claude runtime section; one wording fix; re-review clean
---






# Task

## Context

The README was corrected during planning but lacks Claude setup instructions, which depend on the implemented config and credential guard.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Document how to run a Claude Agent Instance safely.

## Scope

- Add Claude setup: install and sign in to `claude` with a subscription, create `.inoai-connect-claude/` with `--connect-dir`, set `AGENT_PROVIDER=claude` and optional `CLAUDE_MODEL`, validate, and start.
- Explain the credential guard and which sources cause refusal.
- Add the subscription-login policy note (inoai offers no login; each owner uses their own local CLI) and the fail-closed permission behavior.
- Note that project guidance comes from `CLAUDE.md` and `agent.md` changes apply on the next Turn.

## Planner Notes

Keep it consistent with the proposal and Phase 5a docs; no secrets or real IDs.

## Implementation Plan

1. Write the section → verify: commands match the implemented CLI and config names.

## Acceptance Criteria

- [ ] A reader can set up and validate a Claude runtime home from the README alone.
- [ ] The credential, policy, and permission notes match the implementation.

## Notes

- 2026-10-02 worker: Added `## Claude runtime` to README.md (Prerequisites, Setup, Credential guard, Subscription login policy, Behavior, Running alongside Codex) before `## Documentation`. Docs-only; no `src/` changes. Verified commands/keys against `package.json`, `src/index.ts` (`--connect-dir`), `src/config.ts` (`AGENT_PROVIDER`, `CLAUDE_MODEL` rule), `src/claude-runtime.ts` (guard sources, per-Turn `apiKeySource` check, `claude /login` hint), `src/concurrency-probe.ts` (`--model=haiku`, global FIFO fallback), `src/runtime-turn.ts` / `src/conversation-worker.ts` (`/inoai reset` notices). `git diff --check` clean; all relative links resolve.
- 2026-10-02 worker (review fix): Reworded README.md:179 so only the provider-mismatch notice offers a new thread; the missing-session notice asks for `/inoai reset` only. `git diff --check` clean.
