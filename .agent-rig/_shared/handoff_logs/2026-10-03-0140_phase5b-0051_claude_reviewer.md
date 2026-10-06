---
agent: reviewer
role: reviewer
tool: claude
task: task-0051
task_title: "Phase 5b: OpenCode provider configuration and wiring"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0051 reviewer handoff

## Verdict

Clean. No blocking or non-blocking findings. Worker handoff: `2026-10-03-0139_phase5b-0051_claude_worker.md`.

## Acceptance check

- `src/config.ts:20,38-39`: `opencode` accepted; unsupported values (`other`, `OpenCode`, `opencode `) fail with `AGENT_PROVIDER must be codex, claude, or opencode`. No new keys; `CLAUDE_MODEL` still parsed only when `AGENT_PROVIDER=claude` (line 41), and the new config test proves it is ignored for OpenCode.
- `src/conversation-worker.ts:17,20`: map now `a Codex` / `a Claude` / `an OpenCode`; template drops the hard-coded `a `. Compared against `git show HEAD:src/conversation-worker.ts`: Codex and Claude notices are byte-identical (`a ${"Codex"} session` == `${"a Codex"} session`). Unknown values still take the generic branch via `Object.hasOwn`, never echoed (existing test still passes).
- `src/index.ts:355-357`: `case "opencode"` throws inside the existing try; catch calls `instance.release()`. Runs before `ConversationWorker` construction, probe, and transport start, so no external connection; `probeConcurrency` stays the default `async () => false` (never reached). Codex/Claude cases unchanged.
- `README.md:88`: validate sentence updated and accurate. Other README hunks (status line, deferred list) are planning edits, not 0051, and remain consistent.
- `.env.sample` lists only `AGENT_PROVIDER=codex`, no enumerated provider list; unchanged is correct.
- ADR 0001 narrow seam: change is limited to the one config check, one display map, one switch case.

## Tests

- Test names vs HEAD: only additions (one each in config, conversation-worker, transport tests); none removed or renamed. No `.skip/.todo/.only`.
- New transport test captures cwd/PATH/HOME before the try and restores all three in `finally` (deleting when originally unset); temp dir removed. It asserts rejection, no `login`, lock file absent, and a fresh `start()` succeeds.
- Informational only: the comment says "An empty PATH" while PATH is set to the temp dir (empty of binaries); behavior is correct.

## Checks

- `npm test`: 125 tests, 125 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled (122 -> 125 reconciles with 3 added tests)
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- No `.inoai-connect*/.env` read.

## Next

Planner may mark task-0051 done. Task status not changed by reviewer; nothing committed.

## Suggested skills

None required; `code-review` if a further pass is wanted.
