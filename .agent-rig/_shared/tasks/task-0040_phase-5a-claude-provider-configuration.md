---
id: task-0040
title: "Phase 5a: Claude provider configuration"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on: []
message: AGENT_PROVIDER=claude and CLAUDE_MODEL validated; F1 leading-dash fix;
  re-review clean, 89 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---






# Task

## Context

Per-agent configuration stays in the runtime home's `.env` (no YAML). `src/config.ts` currently accepts only `AGENT_PROVIDER=codex`.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Accept a Claude runtime selection and optional model in `.env` without adding any permission-changing setting.

## Scope

- Accept `AGENT_PROVIDER=codex|claude`; keep the exact error for unsupported values.
- Add optional `CLAUDE_MODEL`: blank or absent means the CLI default; reject values that fail a simple format check (no whitespace or shell metacharacters).
- Ignore `CLAUDE_MODEL` for a Codex home; do not add permission, sandbox, approval, or credential keys.
- Update `.env.sample` and the proposal's `.env.sample` block, and `npm run validate` output where it names the provider.
- Add focused config tests.

## Planner Notes

Independent of the spike. Do not wire a Claude runtime yet; selecting `claude` may fail clearly at runtime construction until task-0041/0042 land.

## Implementation Plan

1. Extend validation and types → verify: config tests for valid/invalid provider and model.
2. Update samples → verify: `npm run validate` in a temp runtime home.

## Acceptance Criteria

- [ ] `AGENT_PROVIDER=claude` validates and an unsupported provider fails with its variable name.
- [ ] A malformed `CLAUDE_MODEL` fails validation; blank is accepted.
- [ ] No new key can alter runtime permissions, sandbox, approval policy, or credentials.

## Notes

- 2026-10-02 worker (claude): `AGENT_PROVIDER=codex|claude` and optional `CLAUDE_MODEL` (`[A-Za-z0-9._:\-\[\]]+`, validated and exposed only for a Claude home) implemented in `src/config.ts`; `start` throws "Claude runtime is not implemented yet" before connecting Codex when `claude` is selected. Samples/README updated; 3 config tests added. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-02-2145_phase5a-0040_claude_worker.md`.
- 2026-10-02 worker (claude), review fix F1: `CLAUDE_MODEL` must now start with a letter or digit (`^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$`), so option-like values such as `--dangerously-skip-permissions`, `-p`, `--settings` are rejected; message updated. Regression cases added in `src/test/config.test.ts`. Both judgment calls kept per reviewer. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-02-2150_phase5a-0040-fix_claude_worker.md`.
