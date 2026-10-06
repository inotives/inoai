---
agent: worker
role: worker
tool: claude
task: task-0052
task_title: "Phase 5b: OpenCode runtime adapter"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0052 worker handoff

Status is `review`. Nothing is staged or committed. No `.inoai-connect*/.env`, OpenCode config, OpenCode DB, or credential was read.

## Design

- **connect()**: runs `opencode --version` with no shell, stdio ignored, and a 10 s SIGKILL bound. A failure throws `OpenCode CLI is unavailable`, and `run()` releases the lock in its existing catch.
- **argv per Turn**: `spawn(executable, ["run", "--format", "json", "--standalone", ...(opencodeId ? ["--session", opencodeId] : [])], { cwd: projectPath, stdio: ["pipe", "pipe", "ignore"] })`.
  - No shell, no env option (the environment is inherited unchanged), and no model, auto, yolo, dangerously, fork, or continue flags. No config is written.
  - stderr is discarded because it echoes raw permission resources.
- **Prompt on stdin**: `[inoai operating instructions (not a user message)]\n<agent.md trimmed>\n[end of inoai operating instructions]\n\n<turn prompt>`.
  - `agent.md` is read fresh each Turn by the existing `startAgentSession`/`resumeAgentSession`, and the adapter stores the latest copy on the session state.
- **Session lifecycle and the new seam**:
  - `createSession` returns an inoai key, `inoai-new:<uuid>`, which `startAgentSession` binds as usual (actor `runtime:opencode`).
  - On the first event carrying `sessionID`, the adapter aliases that `ses_` ID to the same state and yields a new provider-neutral `RuntimeEvent` `{ type: "session"; id }` (`src/agent-runtime.ts`).
  - `runRuntimeTurn` (`src/runtime-turn.ts`) immediately calls the new `rebindAgentSession` (`src/database.ts`), a compare-and-set UPDATE from the key to the ses_ ID, with actor `runtime:${agent_provider}`. The rebind happens during the Turn, so a crash later in the Turn still leaves the real ID in SQLite.
  - Later Turns resume with `--session <ses_id>`. Codex and Claude never yield the event, so their behavior is unchanged. The answer branch in `runRuntimeTurn` is the same `else` as before.
  - Why the seam is needed: the real ID only exists after OpenCode creates the session, and the free tier refuses pre-assigned IDs. Without persisting it, a restart could never resume.
- **Existence check**: runs when the session has an OpenCode ID that this process has not seen succeed. That covers a session resumed from SQLite after a restart, and an ID stored from a failed or uncertain first Turn.
  - Command: `opencode api --standalone GET /api/session/<id>`, with no shell, stdout capped at 64 KiB, a 10 s bound, and stderr ignored.
  - Exit 0 → verified, then run.
  - Exit 1 with `_tag: "SessionNotFoundError"` → `session_missing` (not replay-safe).
  - Anything else, including a spawn failure, timeout, or oversized output → `pre_start` (replay-safe).
  - The check is tracked as the active child, so cancel and close can stop it. A cancel during the check → `cancelled`.
  - A Turn that yields an answer also marks the session verified.
- **Orphaned key**: an `inoai-new:` key resumed in a new process (the bridge crashed before the first event) → `session_missing` with no CLI call. This matches the Claude precedent that a never-initialized session needs `/inoai reset` after a restart.
- **Answer**: the `part.text` values of `text` events after the last `step_start`, joined with `"\n\n"`. It is yielded only when the exit is 0, there was no `error` event, the session ID matched, there was no timeout, and the text is nonblank. No progress events are yielded; the worker passes no progress handler.
- **Failure precedence**, first match wins:
  1. Spawn failure (`child.pid === undefined`) → `pre_start` (replay-safe).
  2. `timed_out`.
  3. `provider.auth` → `authentication`.
  4. `provider.rate-limit` or `provider.quota` → `usage`.
  5. Cancel requested → `cancelled`.
  6. Otherwise `uncertain`. This covers any other non-zero exit, a signal, exit 130 without a cancel, an `error` event, exit 0 with no final-step text, and a mismatched `sessionID`, which also SIGINTs the child.

  The existence-check `pre_start` and `session_missing` happen before the run.
- **Cancel, timeout, close**:
  - Cancel and close send SIGINT.
  - The idle timeout (5 min, refreshed on every stdout line) sends SIGTERM.
  - SIGKILL follows after 10 s.
  - The kill guard skips children with no pid and children that have already exited.
  - Each session key allows one active Turn. `close` → `health: stopped` and new Turns fail as `pre_start`.
- **Wiring**: `case "opencode": runtime = await OpenCodeRuntime.connect(); break;`. There is no probe, so the home stays on global FIFO, and there is no denial notifier (task-0053).
- **Denials**: `tool_use` events are ignored. Nothing from them is kept, and the Turn's outcome does not change.
- **Authentication notice**: I left the shared text unchanged ("OpenCode sign-in needs attention. Run opencode auth login locally…"). `ConversationWorker` only archives `outcome.notice` for `session_missing`, and it posts the generic failure notice for `authentication`, so this text never reaches Discord today. Changing it would need a provider-specific field. Task-0054 (README) should cover the free-tier caveat.

## Files

- New `src/opencode-runtime.ts`
- New `src/test/opencode-runtime.test.ts` (11 tests, with a fake CLI in a temp dir)
- `src/agent-runtime.ts` (+session event)
- `src/runtime-turn.ts` (rebind on the session event)
- `src/database.ts` (+`rebindAgentSession`)
- `src/index.ts` (import and wiring)
- `src/test/transport.test.ts`: the 0051 test now expects `OpenCode CLI is unavailable` (lock released). One new `run()` test with a fake `opencode` on PATH covers the answer reaching Discord, the session bound to `ses_…` by `runtime:opencode`, the global-FIFO log line, and that no sentinel or permission text appears in sent messages, logs, or SQLite.

## Test coverage (task bullet → test)

- **Answer**: final-step text only, interim tool-step text excluded, `session` event, resume argv, persona on every Turn, inherited env (a sentinel plus an identical key set), cwd, no forbidden flags, and the secret absent from events. Covered by test 1.
- **Binding**: placeholder → ses_ rebind with the actor, resume through `agent-session`, and no tool data in sessions, messages, or events. Covered by test 2.
- **Existence check once per process**: test 3. For an ID stored from a failed first Turn: test 4.
- **session_missing**: through `runRuntimeTurn` it makes 1 attempt and returns the reset notice. A failed check (no tag) is `pre_start`, retried 3 times without ever running `--session`. Also covers the orphaned key and an unspawnable check. Test 5.
- **Failure kinds and precedence**: a 13-case table in test 6.
- **connect, spawn failure, and a never-spawned first Turn that stays new** (retry has no `--session`): test 7.
- **Timeout**: test 8. **Cancel and resume**: test 9. **Cancel before any event and during the check**: test 10. **Close**: test 11.
- **Lock release**: transport test.
- Mutation sanity: disabling the `step_start` reset or the existence check fails 6 tests.

## Checks

- `npm test`: 125 → 137 tests, 137 pass, 0 fail.
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean. `git diff --no-index --check /dev/null` on both new files: clean.
- OpenCode test file: 13 sequential runs after a full `npm test`, plus 4 runs in parallel, all pass.
  - An earlier version of the timeout test was flaky under load: with a 200 ms timeout the fake was killed before it recorded its pid.
  - Fixed: the fake now records its pid at startup, and the test uses a 500 ms timeout.
- **Real check** (optional, 2 prompts, run in a fresh `mktemp -d` and removed afterwards) against `~/.opencode/bin/opencode` on the free default:
  - connect, then Turn 1 ("Reply with the word ok") yielded a `ses_` ID and "ok".
  - A new runtime instance (simulating a restart) ran the existence check and resumed with `--session` for "What word did you reply with?", recalling "ok" with no rebind.
  - Cleanup: `session delete --standalone` exited 0, and the follow-up `GET` exited 1.
  - Result: `{"connect":"pass","turn1":"pass","turn2":"pass","cleanup":"pass"}`. OpenCode may still keep a per-directory project record (spike section 8).

## Residual risks and notes for the reviewer

- The `active` map is keyed by the key passed to `runTurn`. While a first Turn runs under `inoai-new:…`, a Turn on the aliased `ses_` key would not be rejected by the adapter. `ConversationWorker` runs one Turn per Session, so this cannot happen today.
- An orphaned placeholder after a crash needs `/inoai reset`, the same as Claude.
- If `rebindAgentSession` fails, for example because the session was reset mid-Turn, the error surfaces from `runRuntimeTurn` as `uncertain`, and the child is stopped through the generator's `finally`.
- Rate-limit and quota shapes come from the binary, not from observed runs (spike section 6).

## Suggested skills

`code-review` for the review pass.
