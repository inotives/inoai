---
agent: worker
role: worker
tool: claude
task: task-0059
task_title: "Phase 6: Runtime review seam"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0059 worker fix handoff

Addresses reviewer handoff `2026-10-03-0841_phase6-0059_claude_reviewer.md` (M1, L1). Task set to `review`. Nothing staged or committed.

## Fixes

- **M1, Claude** (`src/claude-runtime.ts:165-169`): after `mkdtemp`/`realpath`, if `signal.aborted` or `this.closed`, remove the cwd and throw `cancelled` (or `pre_start` when closed) before any spawn. Also `src/claude-runtime.ts:225-226`: `if (signal?.aborted) onAbort();` right after attaching the listener.
- **Extra, same race class:** a `close()` during cwd creation would otherwise spawn a child that `close()` never saw. The same check covers it.
- **M1, Codex** (`src/codex-runtime.ts:165-169`): `if (signal?.aborted) onAbort();` after attaching the listener, and `if (failure) throw failure;` as the first statement in the `try`, so no `thread/start` is sent. The `finally` block removes the cwd.

## Tests (`src/test/runtime-review.test.ts`)

- `isolatedTmp()` helper: points `TMPDIR` at a fresh folder so a test can prove that no review cwd is left behind, even one never given to a CLI.
- Fail-closed table: added `missing MCP servers` (expects `uncertain`) and `missing API key source` (expects `authentication`).
- New: "Claude review aborted while its cwd is being created..." aborts in the same tick. Expects `cancelled`, replay-safe, under 5 s, no CLI call, and no cwd left.
- New: "Claude close stops a running review...". `close()` during a hanging review makes it reject replay-safe, the child is dead, and the cwd is gone. A `close()` in the same tick as `review()` gives `pre_start` with no spawn and no cwd.
- New: "Codex review aborted while its cwd is being created...". A same-tick abort gives `cancelled`, `sent` is empty (no `thread/start` or `turn/start`), the server is not closed, and no cwd is left.
- With the source fixes temporarily reverted, all three new tests fail (each runs to the 30 s timeout). With the fixes restored, they pass.

## Checks

- `npm test`: 159 pass, 0 fail, 0 skipped (was 156).
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null src/test/runtime-review.test.ts`: no warnings.
- `runtime-review.test.js` run 5 times serially: 14/14 each time. Run 4 times in parallel with `approval-relay.test.js`: 16/16 each time.
- No leftover `inoai-*review*` temp dirs and no `fake-claude` processes. No real CLI was run. No `.inoai-connect*/.env` was read.

## Remaining risk

The reviewer's residual risks are unchanged: the Codex owner config still loads, the Codex item allowlist is strict, and `turn/start` timeout handling is limited.

## Next

Independent re-review of task-0059. Do not unblock task-0060 until it is clean.
