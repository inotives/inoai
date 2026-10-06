---
agent: worker
role: worker
tool: claude
task: task-0046
task_title: "Phase 5a: Claude concurrency probe"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0046 review-fix worker handoff

This fixes the two Low findings and the test-isolation Info from `2026-10-02-2239_phase5a-0046_claude_reviewer.md`. The probe argv and pass-rule semantics are unchanged.

## Changes

1. **Bounded final wait** (`src/concurrency-probe.ts:146, 169-179`). Each child's wait still resolves on `close`, so all stdout lines are normally read. `exit` now starts a `claudeProbeExitGraceMs` (2 s) timer. If `close` has not fired by then, the timer destroys the child's stdout and stdin and resolves. A SIGKILLed CLI always exits, so the probe returns within timeout + 2 s. The `finally` wait reuses the same promises. The probe does not chase descendants it does not own.
2. **Kill guard** (`src/concurrency-probe.ts:213-216`). `killProbe` is now exported, with a one-line comment. There is a new unit test with fake ChildProcess-like objects: `pid: undefined` → `kill` never called; `exitCode: 0` → not called; pid with no exit → `["SIGKILL"]`. The spawn-failure test was restructured to run the probe in a `detached: true` child node process, which has its own process group. A regressed guard can then only hit that group, never the test runner. The test still asserts `false` and that no project folder is left.
3. **Transport test isolation** (`src/test/transport.test.ts:705, 715-717, 726-727`). `withFakeClaude` sets `HOME` to `<temp>/home` and restores it in `finally`. This is the smallest seam: on macOS `os.homedir()` reads `HOME`, so `run()`'s real `probeClaudeConcurrency()` resolves `~/.claude` under the temp dir. No production signature changed. It covers both Claude `run()` tests that use the helper.

## New tests (`src/test/concurrency-probe.test.ts`)

- "Claude probe returns within its bound when a leftover process keeps the CLI's stdout open". The fake's new `grandchild` mode spawns a detached `node -e setTimeout(60s)` with stdout inherited from the CLI pipe, records its pid, and then hangs. The test runs with timeoutMs 1500 and asserts the probe returns `false` in under 6 s, both CLI pids are dead, the temp project is gone, and the projects dir is empty. `finally` SIGKILLs the recorded grandchildren. Negative check: with the grace temporarily set to 2,000 s, the test hung until node's 15 s test timeout. The change was reverted and rebuilt afterwards.
- "Claude probe kill guard never signals a child without a pid": a pure unit test.
- "Claude probe returns false when the CLI cannot be spawned": the restructured detached test described above.

## Verification

- `npm test`: 122/122 pass.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on the untracked `src/claude-runtime.ts` and `src/test/claude-runtime.test.ts`: no warnings.
- `node --test dist/test/concurrency-probe.test.js` ran 6 times, 8/8 pass each time.
- Leftovers: `$TMPDIR` has no `inoai-claude-concurrency-*`, `inoai-fake-claude-probe-*` or `inoai-claude-run-*` entries. `~/.claude/projects` has no `inoai-claude-concurrency` folder (names only listed). No stray fake-claude, grandchild or test processes.
- I did not run the real CLI or read any `.inoai-connect*/.env`. Nothing is staged or committed.

## For the reviewer

- After the grace timeout, the pass rule still evaluates whatever events were read. This only matters when a CLI exited on its own while a descendant held stdout, so its output is complete. Pass-rule semantics are unchanged.
