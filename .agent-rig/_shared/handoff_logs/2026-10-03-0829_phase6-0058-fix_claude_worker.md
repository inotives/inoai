---
agent: worker
role: worker
tool: claude
task: task-0058
task_title: "Phase 6: Claude text-only review spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0058 worker fix handoff

Applied reviewer findings 1-3 from `2026-10-03-0827_phase6-0058_claude_reviewer.md` to `docs/phase-6-claude-review-spike.md`. Doc only; no CLI runs; evidence is cited as reviewer spot-checks A and B. No `src/` changes. Nothing committed.

## Changes (`docs/phase-6-claude-review-spike.md`)

- :5 scope mentions the two reviewer spot-check calls.
- :46-47 (finding 1) the default system prompt carries auto-memory instructions; the owner's user-level CLAUDE.md loads as user context even with `--system-prompt`; Recap persistence means ID validation does not cover it.
- :98, :103 (findings 3, 4) attribute ID invention to the default prompt's auto-memory instructions; point to finding 6 for `--system-prompt`/`--safe-mode` results.
- :109 (cleanup) no project folder is created with `--system-prompt`; cleanup must tolerate absence (`src/concurrency-probe.ts:219-236` returns on ENOENT).
- :111-129 new finding 6: spot-check A/B table, `--safe-mode` help text, caveats, owner decisions (ADR 0010, Phase 6 task 2, task-0059).
- :144-146 regex plus `JSON.parse` together enforce exactly one object (greedy regex alone accepts two objects/fences); deliberate rejections listed (CRLF fences, ```JSON and other tags, closing fence on the same line, inline fences).
- :152 0059 implication uses the final flag set `-p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config --safe-mode --system-prompt "<fixed review instructions>" [--model=…]`; fail-closed init backstop now includes `memory_paths`; folder cleanup optional; `--model` only with `CLAUDE_MODEL`.
- :157-158 open questions rewritten: `--safe-mode` is a troubleshooting flag (backstop guards version drift, cannot detect CLAUDE.md loading); `--setting-sources`/`--restricted` untested; `--system-prompt`-alone ID invention unproven.

## Checks

- `git diff --check`: clean. `git diff --no-index --check /dev/null docs/phase-6-claude-review-spike.md`: no whitespace errors.
- Redaction grep (`/Users/`, username, `var/folders`, org domain, `sk-`, the CLAUDE.md marker phrase): only false positive `task-0059`.
- Task Notes appended; status set to `review`.

## Next

Independent re-review of the doc.
