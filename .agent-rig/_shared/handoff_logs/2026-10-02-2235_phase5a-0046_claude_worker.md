---
agent: worker
role: worker
tool: claude
task: task-0046
task_title: "Phase 5a: Claude concurrency probe"
status: handoff
---

# task-0046 worker handoff

## What changed

- `src/concurrency-probe.ts`: added `probeShowsConcurrentStreaming(events)` (pure pass rule), `probeClaudeConcurrency({ executable?, homeDir?, timeoutMs? })`, exported `claudeProbeArgs` and `claudeProbeLeftoverWarning`. It lives next to the Codex probe because the module already owns startup concurrency gates. It does not reuse `ClaudeRuntime`, since that argv carries `--session-id`, the appended system prompt, and the owner's model.
- `src/index.ts`: the `claude` branch now sets `probeConcurrency = () => probeClaudeConcurrency()`. The existing log line prints "Claude cross-session concurrency: enabled" or "unavailable; using global FIFO". A supplied runtime still skips the probe and stays on global FIFO. A failed probe only leaves the worker in global mode, so no queued Messages are dropped.
- `src/test/concurrency-probe.test.ts`: added a pass-rule timeline test (overlap passes; sequential, one error, non-`none` or missing `apiKeySource`, same session id, missing delta, result, or init, and unknown process index all fail). Added fake-CLI integration tests on an injected executable and temp home: pass plus cleanup (an unrelated file under `projects/` survives), timeout (both pids dead, cleanup done), a leftover `.jsonl` (folder kept, one fixed warning), and spawn failure (false, no throw).

## Decisions

- **Tools-disable flag (confirmed):** `--tools ""`. Per `claude --help` (2.1.287), "" disables all built-in tools, and a real init event showed `tools: []`. `--strict-mcp-config` with no `--mcp-config` also drops MCP servers (`mcp_servers: []`), so MCP tools are covered too. Both flags only restrict.
- **Argv:** `-p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config --model=haiku`. The prompt goes on stdin, with no shell and stderr ignored.
- **Model:** `haiku` keeps the two throwaway calls cheap and fast. Whether sessions overlap depends on the CLI process model and the account, not on the model.
- **Pass rule:** each of the two processes emits an init with `apiKeySource: "none"` and a non-empty session id, then at least one top-level `text_delta` before its own result, then exactly one result with `is_error: false` and `subtype: "success"`. The two session ids differ. The latest first-delta comes strictly before the earliest result.
- **Bounds:** the default overall timeout is 90 s, after which both children get SIGKILL. A non-`none` init `apiKeySource` kills both at once. Children are always killed and awaited before cleanup, and the probe catches everything.
- **Kill guard:** `killProbe` skips children without a pid. Before this guard, the spawn-failure test killed the shell's whole process group: signalling a never-spawned sibling appeared to signal pid 0. Those killed early runs left 4 empty `inoai-claude-concurrency-*` and 4 `inoai-fake-claude-probe-*` temp dirs, which I removed. The pid-0 explanation is inferred from behavior; I did not trace it in Node. `ClaudeRuntime.stop` signals only after `exited` resolves, so it should not be affected.
- **Cleanup:** the temp project is removed with `rm -r`. Then `join(homeDir, ".claude", "projects", realpath(project).replace(/[^A-Za-z0-9]/g, "-"))` is removed with a non-recursive `rmdir`, and only if it is a real directory holding either nothing or exactly an empty real `memory/` directory. If it is missing, nothing happens. Anything else leaves it in place and logs the fixed warning, which contains no path.

## Verification

- `npm test`: 120/120 pass. `npm run typecheck` and the build are clean. `git diff --check` is clean, and `git diff --no-index --check` shows no warnings for the untracked `src/claude-runtime.ts` and its test. This task added no new untracked source files.
- Exploratory real run (one haiku call) confirmed the init `tools: []`, `mcp_servers: []`, and `apiKeySource: "none"`. Its empty `memory/` project folder was removed by hand.
- Real authenticated probe (two haiku calls): `true` in about 7 s. Afterwards no `inoai-claude-concurrency` folder was left under `~/.claude/projects` or in `$TMPDIR`.

## For the reviewer

- Check that `--strict-mcp-config` fits "preserve the configured CLI's MCP servers". It applies only to the disposable probe sessions, never to live Turns.
- No `.inoai-connect*/.env` was read. Nothing is staged or committed.

## Suggested skills

- `code-review`
