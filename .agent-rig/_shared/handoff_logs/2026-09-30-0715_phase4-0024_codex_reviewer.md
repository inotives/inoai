---
agent: reviewer
role: reviewer
tool: codex
task: task-0024
task_title: "Phase 4: Agent Session lifecycle and streaming"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0024 independent review

## Finding

- **High — early stream disposal permits overlapping turns in one Agent Session.** `src/codex-runtime.ts:79-83` unconditionally removes `active` when the async iterator is closed, including after a consumer calls `return()` or breaks out of `for await` following a progress event. In that path no `turn/interrupt` is sent and no `turn/completed` was observed, so Codex's first turn may still be running. `runTurn()` then admits a second turn for the same session at lines 33-34. A deterministic probe against the built adapter yielded `turnStarts 2`, `interrupts 0`, and no first-turn completion. This violates the one-active-turn-per-Session invariant and can corrupt later-turn ordering. Keep the session occupied until Codex confirms completion/interruption, or interrupt and await a terminal signal before releasing it; add an early-consumer-stop regression test. Also treat an interrupt failure or process loss as uncertain, never as a successful clean cancel.

## Checks and scope

- `npm test`: 53 pass, 0 fail. `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- Installed Codex app-server schema accepts `developerInstructions` and `cwd` for `thread/start` and `thread/resume`; protocol docs support `turn/interrupt` and terminal `turn/completed` notification.
- The guarded SQLite update binds only active pending sessions; no API key, permission override, global configuration edit, or runtime-home access appeared in task 0024 code.
- Existing tests cover normal completion/cancellation and process loss, but not early iterator disposal. No implementation edits made. Leave task in `review` for planner to return to worker; do not unblock task 0025 yet.

Official protocol reference: https://learn.chatgpt.com/docs/app-server
