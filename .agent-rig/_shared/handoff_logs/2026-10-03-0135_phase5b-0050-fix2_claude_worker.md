---
agent: worker
role: worker
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Worker fix 2: task-0050 spike doc (re-review N1, N2, N6)

## Changes (doc only: `docs/phase-5b-opencode-cli-spike.md`)

- **N1 (Medium):**
  - :154: the `pre_start` (replay-safe) row now covers only a spawn failure (ENOENT/EACCES) of `opencode run`. The "non-zero exit with zero parsed stdout events" clause is removed.
  - :160: the `uncertain` row now explicitly includes any non-zero exit or signal, including one with zero parsed stdout events.
  - :162: the rule is rewritten. Replay-safe `pre_start` is only a spawn failure or an existence-check failure without `SessionNotFoundError`. The reason: the user message is stored about 0.3 s after spawn (§7), but the first event arrives at 1.0–4.1 s (§1). A crash or kill in that window may already have stored the message or run a tool. The free-tier sample is cited as evidence.
  - :164: new precedence paragraph: spawn failure → `timed_out` → `authentication`/`usage` → `cancelled` → `pre_start` (existence check) → `uncertain`. It mirrors `src/claude-runtime.ts:110-116` and notes the departure from Claude, since OpenCode has no early init event.
  - :138 already matched and is unchanged.
- **N2 (Low)**, :80: the paragraph is marked "superseded by D1 … the adapter does not use this API", and the contradicting "planned fallback: prepend … then PUT" sentence is removed.
- **N6 (Info)**, :140: added that a `sessionID` stored from a first Turn that failed or was `uncertain` is also checked before its first resume.

## Checks

- `git diff --check`: rc 0.
- `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md`: no output (rc 1 only because a diff exists).
- Redaction grep (full `ses_` IDs, `/Users/`, username, `/var/folders`, `/private/`): no hits.
- No CLI runs, no `src/` changes, nothing committed.
- The task was set to `review`, and a Notes line was appended.

## Next

Quick reviewer re-check of N1, N2, and N6. N3–N5 were handled by the planner in tasks 0052, 0053, and 0054.
