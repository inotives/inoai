---
id: task-0051
title: "Phase 5b: OpenCode provider configuration and wiring"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: AGENT_PROVIDER=opencode, mismatch map, opencode switch branch; review
  clean, 125 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Context

`src/config.ts` accepts `codex|claude`; the provider-mismatch notice map in `src/conversation-worker.ts` covers codex and claude; `src/index.ts` has one provider switch.

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Accept an OpenCode runtime selection and wire the provider-neutral pieces.

## Scope

- Accept `AGENT_PROVIDER=opencode`; update the unsupported-provider message to list all three. No model, permission, sandbox, approval, or credential keys.
- Add `opencode → OpenCode` to the provider-mismatch display map.
- Add an `opencode` branch to the provider switch that fails clearly with "OpenCode runtime is not implemented yet" inside the existing try (lock released) until task-0052; probe stays `async () => false` (global FIFO).
- Update `.env.sample` comments if any list providers, the proposal `.env.sample` block if needed, and the README validate sentence.
- Focused tests: config accepts `opencode`; mismatch notice names OpenCode; selecting `opencode` fails before any external connection and releases the lock.

## Planner Notes

Independent of the spike. Codex and Claude behavior must be unchanged.

## Implementation Plan

1. Extend config, map, and switch → verify: focused tests.
2. Full checks → verify: npm test, typecheck, build, diff check.

## Acceptance Criteria

- [ ] `AGENT_PROVIDER=opencode` validates; unsupported values fail naming the variable.
- [ ] The mismatch notice names OpenCode for an opencode-bound thread.
- [ ] The opencode branch fails cleanly and releases the lock until the adapter lands; Codex and Claude unchanged.

## Notes

- 2026-10-03 worker (claude): `AGENT_PROVIDER` accepts `codex|claude|opencode` (message: `AGENT_PROVIDER must be codex, claude, or opencode`); `Configuration["agentProvider"]` widened; no new keys; `CLAUDE_MODEL` still Claude-only. Mismatch map gains OpenCode; map now stores the article (`a Codex`, `a Claude`, `an OpenCode`) so the notice reads "an OpenCode session" (Codex/Claude text unchanged). `run()` `opencode` branch throws `OpenCode runtime is not implemented yet` inside the existing try (lock released); probe stays `async () => false`. README validate sentence updated; `.env.sample` and proposal block do not enumerate providers, left unchanged. Tests 122 -> 125, typecheck/build/diff check clean. Set to review.
