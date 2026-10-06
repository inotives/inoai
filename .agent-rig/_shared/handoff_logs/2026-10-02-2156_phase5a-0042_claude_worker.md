---
agent: worker
role: worker
tool: claude
task: task-0042
task_title: "Phase 5a: Claude runtime adapter"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0042 worker handoff

Read: `AGENTS.md`, worker role files, task-0042, `docs/phase-5a-claude-cli-spike.md`, Phase 5a in `docs/implementation-phases.md`, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0007, 0008, and the 0039/0040/0041 handoffs.

## Changes

- `src/claude-runtime.ts` (new): `ClaudeRuntime implements AgentRuntime`, with `displayName: "Claude"` and `loginHint: "claude /login"`, so the auth notice reads "Run claude /login locally". `ClaudeRuntime.connect()` spawns `claude --version` once (no shell, stdio ignored, 10 s cap) and rejects with "Claude CLI is unavailable". The executable, model, and idle timeout can be injected.
- `src/index.ts`: the `claude` branch is now `runtime = await ClaudeRuntime.connect({ model: configuration.claudeModel })`. There is no approval relay, and the probe stays at the default `async () => false` (global FIFO). The class is re-exported.
- `src/agent-session.ts`: binds with actor `runtime:${session.agent_provider}`, so Codex is still `runtime:codex` and Claude is `runtime:claude`. The resume error now reads "Agent Session has no runtime session to resume".
- `src/database.ts`: "Invalid Codex thread ID" is now "Invalid Agent Session ID".
- `src/test/claude-runtime.test.ts` (new): 10 tests against a fake Node CLI in a `mkdtemp` folder. The fake records argv, cwd, stdin, and pid, then replays recorded stream-json lines for each call.
- `src/test/transport.test.ts`: the Claude lock test now sets `PATH` to an empty temp dir so `connect` fails without running the real CLI. It asserts no Discord login, the lock released, and a clean restart.

## Design

- **argv** (spawned with `spawn`, no shell, cwd = project path): `-p --output-format stream-json --verbose --include-partial-messages (--session-id|--resume) <uuid> --append-system-prompt=<agent.md> --system-prompt-snapshot off --permission-prompts none [--model=<CLAUDE_MODEL>]`. The prompt goes in on stdin, so a prompt that starts with `-` can't be read as a flag. `agent.md` and the model are passed as single `--flag=value` elements. stderr is discarded. The adapter passes no allow, bypass, settings, permission-mode, MCP, or tools flags, and it doesn't change the environment.
- **Session lifecycle**: `createSession` returns `randomUUID()` with state `new`. Seeing init with a matching `session_id` sets state `persisted`. `resumeSession` stores the project path and the current `agent.md` and keeps any known state. An ID not seen in this process (after a restart) gets state `unknown`.
  - `new` uses `--session-id`. A first Turn that failed before init stays `new`, so it isn't resumed.
  - `persisted` and `unknown` use `--resume`.
  - If an `unknown` resume fails before init with "No conversation found with session ID", the same Turn is retried once with `--session-id`. That happens only without a cancel request and before close.
  - The same failure on a `persisted` session is `pre_start` with replaySafe=true. The session is never silently recreated.
  - Only one Turn can be active per session. `resumeSession` and `runTurn` throw while a Turn is running.
- **Stream**: a top-level `stream_event` `text_delta` (`parent_tool_use_id == null`) becomes `progress`. The final `answer` comes from `result.result`. Unknown events, non-JSON lines, tool_use, tool_result, `permission_denied`, and `permission_denials` are skipped and never yielded or logged, so denials don't break a Turn.
- **Failure mapping**: classified in this order, using the result event and flags rather than the exit code:
  1. spawn error before init → `pre_start`, replaySafe=true
  2. init for a different session ID → SIGINT, then `uncertain`
  3. `is_error:false` + `subtype:success` + string result → answer
  4. idle timeout → `timed_out` (SIGTERM, then SIGKILL after 10 s)
  5. assistant `error` in authentication_failed, oauth_org_not_allowed, account_on_hold, or verification_required → `authentication`
  6. assistant `error` rate_limit or billing_error, or `rate_limit_event` `rejected` → `usage`
  7. no init → `pre_start`, replaySafe=true
  8. cancel requested and (`aborted_streaming` or no result) → `cancelled`
  9. anything else, including `aborted_streaming` without a cancel → `uncertain`

  The idle timeout is 300 000 ms. The timer starts at spawn and resets on every stdout line.
- **cancel**: sets `cancelRequested`, sends SIGINT, and waits for the process to close. `close` sets the runtime to stopped, SIGINTs and awaits every active child, and later Turns get `pre_start` with replaySafe=true. The generator's `finally` also SIGINTs and awaits a child that is still running if the consumer abandons the Turn.

## Real-CLI verification (spike review finding B): PASS

I used Claude Code 2.1.287 in a fresh `mktemp -d` cwd with `--model=haiku`, the adapter's exact flag set, and the prompt on stdin. I did not use `--no-session-persistence`, because it would have defeated the resume check.

1. Turn 1: `--session-id <uuid>` with `--append-system-prompt=Always end every answer with the exact token ZEBRA-42.` Result: success, "Hey there, friend. ZEBRA-42".
2. Turn 2: `--resume <uuid>` with the append text changed to `QUOKKA-7`. Result: success, `I said "Hey there, friend" as a three-word greeting. QUOKKA-7`.

On a resumed Turn, the changed append text took effect and the conversation context was kept. Both runs also confirmed:
- The init `session_id` matched the supplied UUID, and init `apiKeySource` was `none`.
- The `--flag=value` forms and the stdin prompt both work.
- Top-level `text_delta` stream events arrive with `parent_tool_use_id:null`.
- Both runs exited 0.

Cleanup: the folder `~/.claude/projects/<encoded temp cwd>` held only `<uuid>.jsonl` and an empty `memory/`. I deleted it by literal path, along with the temp cwd. No other `~/.claude` content, settings, or credentials were touched, and no `.inoai-connect*` was read.

## Deviations from the spike

- I added `--include-partial-messages`, which the spike documented as the `text_delta` source, so progress comes from deltas and the idle timer resets during long generations.
- The prompt goes in on stdin instead of as a positional argument, for argv-injection safety. Verified above.
- I added the fallback for an unknown resume ID after a restart, described under Session lifecycle. The spike lists unknown resume as `pre_start`, and it still is for sessions this process saw start.
- `connect()` runs `claude --version` as the startup failure point the lock-release coverage needs. It checks no credentials; that is task-0044.

## Checks

- `npm test`: 102 tests, 102 pass, 0 fail (10 new in `claude-runtime.test.ts`). The Claude file passed 3 extra standalone runs with no flakes.
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean (new files marked intent-to-add with `git add -N` so the check covers them; nothing staged or committed)

## Residual risk

- After a restart, a session whose transcript the CLI itself deleted (`cleanupPeriodDays`) would restart fresh under the same ID and lose context, because state is in memory only.
- The usage-limit and expired-auth stream shapes are still unobserved (spike open question). They map from the binary's error enum.
- SIGINT during a running tool call is untested. Without a cancel request it is `uncertain`; with one it is `cancelled`. Neither is replayed.

## Next

An independent review of task-0042. Tasks 0043 (denial notices from `permission_denied`/`permission_denials`, names and count only), 0044 (credential guard, which can extend `connect()` and the init `apiKeySource` check), and 0046 (probe) plug into `ClaudeRuntime`.

## Suggested skills

- `code-review`, `security-review` (argv and secret handling)
