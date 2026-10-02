---
agent: reviewer
role: reviewer
tool: claude
task: task-0046
task_title: "Phase 5a: Claude concurrency probe"
status: done
---

# task-0046 re-review (after fix round)

Independent re-review of the fix described in `2026-10-02-2245_phase5a-0046-fix_claude_worker.md`, checked against the findings in `2026-10-02-2239_phase5a-0046_claude_reviewer.md`. I made no implementation edits and did not change the task status.

## Verdict

Clean. Both earlier Low findings and the transport-test Info are resolved. I found no new findings at Low or above.

## 1. Startup bound and fail-closed

- `src/concurrency-probe.ts:169-179`: each wait resolves on `close`. `exit` starts a 2 s grace timer that destroys stdout and stdin and then resolves.
  - A SIGKILLed CLI always emits `exit`, so `await Promise.all(exits)` (198, and again at 206) ends within timeout + 2 s.
  - `done` clears the grace timer when `close` wins. Resolving twice is harmless.
  - The `finally` block clears the main timer.
  - None of the promises reject, so there are no unhandled rejections.
- Can the grace path pass on partial output? No.
  - Every probe-initiated kill path sets `failed = true` before it signals: the timeout (164), a spawn or child `error` (172), and a non-subscription init (186). Line 199 then returns `false` whatever events were read.
  - The grace path can only matter when a CLI exits on its own. In that case it has already written everything it will write. Lines are read in order, and the pass rule requires a `result` with `subtype: "success"` from each process, plus deltas that come before both results.
  - So truncation can only remove events. Losing a result, or anything before it, gives `false`. Losing data after the result does not change the verdict.
  - A partial trailing line is never emitted on `destroy`. If it were, `JSON.parse` would drop it.
  - If the timeout fires during the grace wait, `failed` is set and the probe fails closed.
- Info (no action needed): if a child emitted `error` after a successful spawn and then exited, a grace timer created after `done` would stay armed for up to 2 s. It is harmless: it delays nothing and resolves an already-settled promise.

## 2. Kill guard and spawn-failure isolation

- "kill guard never signals a child without a pid" (test:195-210) uses fake objects only and sends no real signals. It covers three cases: `pid` undefined, already exited, and running → `["SIGKILL"]`. It would catch a regression of the `pid !== undefined` check at `src/concurrency-probe.ts:216`.
- The spawn-failure test (test:212-229) runs the probe in a `detached: true` node child, so the child has its own pgid. A regressed guard would `kill(0)` only that group. The child would then die by signal and `code` would be null, so the test fails loudly instead of killing the runner. Cleanup removes the temp dir.
- The grandchild test kills its recorded grandchildren in `finally`. `ps` found no stray processes after 7 full runs.

## 3. HOME override in transport tests

- `src/test/transport.test.ts:704, 715-716, 726-727`: the previous HOME is saved, a temp HOME is set, and in `finally` HOME is deleted if it was unset and restored otherwise. Both Claude `run()` tests (739, 756) go through `withFakeClaude`.
- Production code is unchanged. `index.ts` still calls `probeClaudeConcurrency()` with the default `homedir()`.
- Node v24.20.0 on macOS: `HOME=/tmp/xyzhome node -e 'os.homedir()'` prints `/tmp/xyzhome`. With HOME unset, it falls back to the passwd entry.

## 4. Argv and pass rule

`claudeProbeArgs` (141-144) and `probeShowsConcurrentStreaming` (112-134) match the first review exactly. The only production change is the exit-grace wait and exporting `killProbe`.

## 5. Checks

- `npm test`: 122/122 pass, 0 fail.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on the untracked `src/claude-runtime.ts` and `src/test/claude-runtime.test.ts`: no whitespace warnings.
- `node --test dist/test/concurrency-probe.test.js` ran 6 times, 8/8 pass each time.
- Leftovers:
  - `$TMPDIR` and `/tmp` have no `inoai-claude-concurrency-*`, `inoai-fake-claude-probe-*` or `inoai-claude-run-*` entries.
  - `~/.claude/projects` has no matching folders (names only listed).
  - `ps` shows no fake-claude, grandchild, spawn-failure or test node processes.
- Real CLI: none run. I did not read any `.inoai-connect*/.env`.
