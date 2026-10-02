---
agent: reviewer
role: reviewer
tool: claude
task: task-0046
task_title: "Phase 5a: Claude concurrency probe"
status: done
---

# task-0046 reviewer handoff

Independent review of `src/concurrency-probe.ts`, the `claude` branch in `src/index.ts`, and `src/test/concurrency-probe.test.ts`. I made no implementation edits and did not change the task status.

## Verdict

Clean. Nothing blocks the task. There are two Low advisories and a few Info notes below. None of them breaks an acceptance criterion.

## Kill safety

There is no remaining path that signals pid 0, a negative pid, or the parent's process group.

- Root cause, confirmed on Node v24.20.0. When `spawn` fails with ENOENT, it returns a ChildProcess whose `_handle` is still alive until the next tick. That handle has an internal pid of 0, while `child.pid` is `undefined`. I checked this with a scratch script and sent no signals. Calling `child.kill()` in that window runs `uv_kill(0, sig)`, which means `kill(0)` and hits the whole process group. The probe could fall into that window because both children are spawned in one synchronous loop. Child 0's `error` handler then called `killAll` while child 1's handle still existed.
- `killProbe` (concurrency-probe.ts:206-208) signals a child only when `pid !== undefined` and the child has not exited. That closes the window. Node never sets `pid` on a failed spawn, and it nulls `_handle` before emitting `error`. All three kill sites go through `killProbe`: the timer (163), `error`/init refusal (169, 178), and `finally` (196).
- `ClaudeRuntime` (claude-runtime.ts):
  - `connect --version` (52) and `readAuthStatus` (240, 243) kill only from a 10 s timer or from a stdout `data` event. Both happen after the failed spawn's `onErrorNT` has already nulled the handle, so the call is a no-op.
  - `stop()` (208-215) is reached from the idle timer, from init events (which need stdout), or from `cancel()` in a later macrotask. In each case `exitCode` is already -2 or the handle is null.
  - No hazard.
- Codex (codex-app-server.ts:29, 107, 111): the kill at line 29 needs stdout lines, and `close()` runs later, so the handle is already null on a spawn failure. No hazard.
- Neither file calls `process.kill` with a computed pid. The only `process.kill` is in the test's `alive(pid, 0)`, which uses the real pid recorded by the fake.

## `--strict-mcp-config` ruling

It is consistent with the AGENTS.md rule to preserve the configured CLI's skills, MCP servers, sandbox, and approval policy.

- That rule protects the owner's live Turns.
- `claudeProbeArgs` is used only by `probeClaudeConcurrency`. `ClaudeRuntime.args` (claude-runtime.ts:131-139) contains neither `--tools` nor `--strict-mcp-config`, and grep finds no other use.
- The probe sessions are disposable, tool-free, and never carry owner work.
- Removing MCP servers there only restricts. It also avoids starting owner MCP processes, with their side effects, during startup.
- `claude --help` (2.1.287) confirms `--tools ""` ("disable all tools") and `--strict-mcp-config` ("Only use MCP servers from --mcp-config"). No `--mcp-config` is passed. There is no shell, and the argv holds no permission-granting flag.

## Findings

1. **Low: the timeout does not bound the final await.** At concurrency-probe.ts:168-171, 190 and 198, `exits` resolves on `close`, which waits for the child's stdio to close. If a grandchild of a SIGKILLed CLI held the stdout pipe open, `close` would never fire. Startup would then block forever before Discord starts, because `index.ts` awaits the probe first. The likelihood is low: tools and MCP are disabled, but owner hooks still run (see Info). Fix: resolve on `exit` instead, or race `Promise.all(exits)` against a short grace period after the kill. Optionally destroy `child.stdout`.
2. **Low: the only regression check for the kill guard is destructive.** "Claude probe returns false when the CLI cannot be spawned" covers the guard implicitly. If the guard regressed, that test would SIGKILL the test runner's process group, the same incident the worker saw. Fix: add a unit check that `killProbe`, or `killAll` via an injected spawn, never calls `kill` on a child whose `pid` is undefined. A fake ChildProcess with `pid: undefined` and a `kill` spy would do.

## Info

- Owner hooks and plugins from user settings still load in the probe sessions. `--tools ""` does not disable hooks. This grants nothing new, but owner hooks could write outside the temp project. `--setting-sources` is an option if this ever matters. I am not asking for a change, because the rule is to preserve the configured CLI.
- `docs/phase-5a-claude-cli-spike.md:157` still lists the tools-disable flag as open. The answer is recorded in the task notes and the code comment. task-0047 or task-0049 could close that line.
- The transport test "Claude startup with the subscription login…" reaches the real `probeClaudeConcurrency()` against the fake `claude` on PATH, using the real `homedir()`. The fake reports the same session id `-p` for both runs, so the probe returns false. Cleanup only `lstat`s a unique temp-derived name under `~/.claude/projects`, gets ENOENT, and touches nothing. This is harmless and the real CLI is never called.

## Checks (all clean)

- Pass rule: requires an init with `apiKeySource === "none"` and a non-empty, distinct session for each process. Deltas must come after init (a delta before init fails the run), and only deltas before that process's own result count. Exactly one result, with `is_error: false` and `subtype: "success"`. The pass condition is max(first delta) < min(result). Unknown process indexes and non-objects fail. The rule is strict and correct.
- Fail-closed: a non-`none` or missing `apiKeySource` on a live init kills both children at once and sets `failed`. Spawn errors set `failed`. Everything is caught, and the function never throws.
- Cleanup: the temp project is removed with `rm -r`. Only the folder `join(homeDir, ".claude/projects", realpath(project) with non-alphanumerics replaced by "-")` is touched. It is checked with `lstat`, so a symlink is rejected. It is removed only when empty, or when it holds just an empty real `memory/`, using non-recursive `rmdir`. Otherwise the fixed warning `claudeProbeLeftoverWarning` is logged; it contains no path. The tests inject a temp home, and an unrelated file under `projects/` survives.
- Wiring: the `claude` branch sets `probeConcurrency = () => probeClaudeConcurrency()`. A supplied runtime keeps the default `async () => false` and skips the log. The log line is `${displayName} cross-session concurrency: enabled|unavailable; using global FIFO`, which matches the Codex style. A failure leaves the worker in global mode, and the probe runs before the transport starts, so queued SQLite Messages are untouched.
- `npm test`: 120/120 pass, 0 fail.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on the untracked `src/claude-runtime.ts` and `src/test/claude-runtime.test.ts`: no warnings.
- Flakiness: `node --test dist/test/concurrency-probe.test.js` ran 8 times, 6/6 pass each time.
- Leftovers: `$TMPDIR` has no `inoai-claude-concurrency-*`, `inoai-fake-claude-probe-*` or `inoai-claude-run-*` entries. `~/.claude/projects` has no matching folders (names only listed).
- Real CLI: only `claude --version` (2.1.287) and `claude --help`. I did not run the real probe and did not read any `.inoai-connect*/.env`.

## Suggested skills

- `code-review` (for task-0049 integrated review)
