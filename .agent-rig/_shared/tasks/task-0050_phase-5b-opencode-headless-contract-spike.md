---
id: task-0050
title: "Phase 5b: OpenCode headless contract spike"
type: research
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: OpenCode v2.0.22 headless contract verified; three review rounds, final clean
---








# Task

## Context

Planning facts came from `--help`, docs, and the binary only; no real run has been observed. OpenCode v2.0.22 lives at `~/.opencode/bin/opencode`; by default the CLI talks to a background service, so the adapter will use `--standalone`. No OpenCode provider is authenticated; the default model is a free OpenCode Zen model. The owner approved a few short, harmless prompts to opencode.ai for this spike.

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Record the verified headless contract the adapter and denial tasks rely on.

## Scope

- Use only a fresh disposable directory from `mktemp -d` as cwd; never run in the repo; never touch `.inoai-connect*`, OpenCode config, `service.json`, credential storage, or `GET /api/credential`/`auth export`. Use the default model; keep prompts tiny and harmless.
- Capture `opencode run --format json --standalone` NDJSON shapes for text, tool use, errors, and session IDs; confirm stdout vs stderr split, exit codes (0/1/130), and whether a reliable end-of-turn signal exists.
- Sessions: whether `--session <pre-assigned ses_…>` works on a first run, resumes across separate standalone runs, and what an unknown ID does; a supported way to check a session exists before resuming without creating it (for `session_missing`); how to delete spike sessions (`opencode session delete`).
- Persona: whether `OPENCODE_CONFIG_CONTENT` with an `instructions` entry pointing at a temp file reaches a standalone run, adds to rather than replaces the default prompt, and coexists with a project `opencode.json` `instructions` list and a project `AGENTS.md`; whether edits apply on the next run.
- Permissions: trigger an action the default rules `ask` for (e.g. reading a `.env` file in the temp dir, or an external-directory access) and record exactly how the auto-rejection appears on stdout and stderr. Never pass `--auto`/`--yolo`/`--dangerously-skip-permissions`.
- SIGINT mid-run: events, exit code, and whether the session still resumes.
- Free-tier rate-limit/error shape if observable; standalone startup latency (a few samples).
- Write findings to `docs/phase-5b-opencode-cli-spike.md` with redacted, minimal samples and the OpenCode version.

## Planner Notes

Research only: no `src/` changes. Stop rule: if standalone runs cannot resume a session across processes, or startup is unreasonably slow (state the measurements), set the task `blocked` with the reason so the planner can return to the owner. Clean up every spike session and temp dir you create.

## Implementation Plan

1. Run the probes in a temp project and record results → verify: every scope bullet answered or explicitly unknown.
2. Write the spike doc with redacted samples and clean up sessions → verify: no secrets, IDs redacted, no leftover spike sessions.

## Acceptance Criteria

- [ ] `docs/phase-5b-opencode-cli-spike.md` answers every scope item with the observed version.
- [ ] Session resume across standalone runs, the existence check, the persona mechanism, and denial reporting are confirmed, or the task is blocked with a reason.
- [ ] No OpenCode config, credential, or repository runtime home was read or modified, and spike sessions were removed.

## Notes

- 2026-10-03 (worker, claude): Spike done against opencode v2.0.22; findings in `docs/phase-5b-opencode-cli-spike.md`. 11 trivial prompts (10 standalone, 1 via service). Resume across standalone processes works; standalone startup ~0.3 s, so stop rule not triggered. Read-only existence check: `opencode api --standalone GET /api/session/<id>` (exit 1 + SessionNotFoundError when missing); `--session <unknown>` silently creates. Pre-assigned `ses_` IDs fail on the free tier (provider.auth 403 FreeTierError), so the adapter must let OpenCode create the session. **Planner decision needed:** `OPENCODE_CONFIG_CONTENT` `instructions` (and project `opencode.json` `instructions`) are NOT applied in 2.0.22; only AGENTS.md is. Working additive alternative: experimental `PUT /api/experimental/session/<id>/instructions/entries/<key>` (edits applied on next run), or the planned delimited-prompt fallback. Denials: `tool_use` status error with fixed text + stderr `permission requested: … auto-rejecting`, exit 0. SIGINT: exit 130, `error` type `unknown`, session resumes. All 8 spike sessions deleted and verified; all temp dirs removed. No src/ changes.
- 2026-10-03 (worker, claude): Review fixes applied, doc only, no CLI runs, no src/ changes. Spike doc now records owner decision D1: `agent.md` is prepended to every Turn's stdin prompt as a delimited "inoai operating instructions (not a user message)" block, and it lists the docs the planner updated. Also added: a single `pre_start` rule (spawn failure, or a non-zero exit with zero parsed stdout events; any `sessionID` event means the Turn started); an existence-check exit 1 without SessionNotFoundError maps to `pre_start`; the check runs only for sessions not yet seen to succeed in this process; denials are count-only, counted from stdout `tool_use` errors with the fixed prefix, with stderr never added; whether stdout and stderr counts match is unknown and left to task-0053; a free-tier risk note for task-0054 and the authentication notice; the answer is final-step text events joined by "\n\n".
- 2026-10-03 (worker, claude): Second review fix, doc only, no CLI runs, no src/ changes. N1: replay-safe `pre_start` is now only a spawn failure (ENOENT/EACCES) or an existence-check failure without SessionNotFoundError. Any other non-zero exit or signal after spawn, including one with zero parsed stdout events, is `uncertain`, because the user message is stored about 0.3 s after spawn but the first event comes at 1–4 s. The doc now states the precedence (spawn failure → timed_out → authentication/usage → cancelled → pre_start → uncertain) and notes that this departs from Claude, since OpenCode has no early init event. N2: the §3 fallback paragraph is marked superseded by D1, and the contradicting prepend-then-PUT sentence is removed. N6: a sessionID stored from a failed or uncertain first Turn is checked before its first resume.
