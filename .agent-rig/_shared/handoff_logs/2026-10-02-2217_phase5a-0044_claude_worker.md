---
agent: worker
role: worker
tool: claude
task: task-0044
task_title: "Phase 5a: Claude subscription credential guard"
status: handoff
---

# task-0044 worker handoff

Status is `review`. Nothing is staged or committed. No `.inoai-connect*/.env` was read. I ran the real `claude auth status --json` once, through the built guard; the only thing printed was the verdict ("accepted").

## Startup guard (`ClaudeRuntime.connect`, `src/claude-runtime.ts`)

Order of checks:
1. `claude --version`, which was already there.
2. `"CLAUDE_CODE_OAUTH_TOKEN" in process.env`. This checks presence only: the value is never read, printed, or stripped, and an empty value is also refused.
3. `claude auth status --json`:
   - It is spawned without a shell, with stdin and stderr set to `ignore`, a 10 s SIGKILL timeout, and a 64 KiB stdout cap.
   - Parsing keeps only `loggedIn`, `authMethod`, `apiProvider`, `apiKeySource`, plus whether the `apiKeySource` key is present. Email, org, and every other field are dropped.
   - A `JSON.parse` error message quotes its input, so it is replaced with a fixed message.
   - Nothing from the output is logged or persisted.

How each source maps to a refusal. Labels are fixed strings and never values:

| Signal | Refusal names |
|---|---|
| `apiKeySource` key present: `ANTHROPIC_API_KEY` / `apiKeyHelper` / `/login managed key` / any other value | "an API key (ANTHROPIC_API_KEY)" / "an apiKeyHelper" / "a Console API key (/login managed key)" / "an API key" |
| `apiProvider` not `firstParty` | "a cloud gateway" for `gateway`; "a cloud provider" for anything else |
| `authMethod` `oauth_token` (covers `ANTHROPIC_AUTH_TOKEN`, a settings-env token, or an Anthropic profile; the CLI bundle's status logic maps all of these to it) | "an auth token or Anthropic profile …" |
| `authMethod` `api_key_helper` / `api_key` / `third_party` / unknown value | apiKeyHelper / API key / cloud provider / unsupported source |
| `CLAUDE_CODE_OAUTH_TOKEN` in the environment | "CLAUDE_CODE_OAUTH_TOKEN in the environment" |
| `loggedIn !== true` or `authMethod: "none"` | "Claude subscription sign-in is required; run claude /login locally" |
| Non-string `authMethod`/`apiProvider`, unparsable output, nonzero exit, timeout, oversize output | "…could not be verified; run claude /login locally" |

A refusal is thrown from `connect()`. `run()` already calls `instance.release()` in that case, so the lock is released and Discord never logs in.

## Per-Turn check (`attempt` init handling)

- **Trigger:** an init event whose `apiKeySource !== "none"`. A missing field also triggers it.
- **What happens:** `credentialRefused` is set, the CLI gets SIGKILL immediately, and every later event is drained unused (no progress, answer, or denial count). The Turn fails as `RuntimeFailure("authentication")` and is **not replay-safe**. `runRuntimeTurn` never retries `authentication`, so the Turn gets one attempt and the existing notice with `claude /login`.
- **Why not replay-safe:** the CLI had already initialized, and the API request may already have been sent, so I can't show nothing started. A replay would also meet the same credential.
- **Session state:** the session is still marked `persisted` when the init ID matches, because the CLI may have recorded it. A later Turn therefore resumes instead of reusing `--session-id`. If no transcript exists, that Turn becomes `session_missing` and the owner uses `/inoai reset`.

## Files

- `src/claude-runtime.ts` (untracked): the guard, its helpers, and the init check.
- `src/test/claude-runtime.test.ts` (untracked):
  - The connect test now covers acceptance and both argv calls.
  - A refusal table with 17 fixtures, including `authMethod: "oauth_token"` with the env var unset.
  - An env-presence test with a non-empty and an empty value. It asserts `auth status` is never called and the env is unchanged.
  - A per-Turn test: init `apiKeySource` is `ANTHROPIC_API_KEY`, `apiKeyHelper`, or missing, against a hanging fake. It asserts the process is dead, nothing was yielded, and the `runRuntimeTurn` notice is correct.
- `src/test/transport.test.ts`: two `run()` tests with a fake `claude` on PATH that answers `--version`, `auth status --json` (pretty-printed JSON), and `-p`:
  - **Refusal:** names the API key, never logs in to Discord, releases the lock, and writes no events.
  - **Successful start:** a mention creates a thread, the denied Turn posts the task-0043 notice plus the answer, and there is one `approval_unsupported` Event. No sentinel identity or tool input appears in sends, console output, or events.

The tests save and restore `PATH` and `CLAUDE_CODE_OAUTH_TOKEN`, deleting each one if it was originally unset.

## Checks

- `npm test`: 113 tests, 113 pass, 0 fail.
- `node --test dist/test/claude-runtime.test.js`: 18 of 18 pass.
- `npm run typecheck` and `npm run build`: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on the untracked src/docs files: clean.
- `git diff --cached`: empty.

## Risks and notes for the reviewer

- **Unverified CLI outputs:** only the subscription output has been observed. The other fixtures follow the CLI 2.1.287 bundle's status logic. That logic adds `apiKeySource` whenever `ANTHROPIC_API_KEY` is set, and maps profile/auth-token sources to `oauth_token`.
- **No timeout test:** the 10 s `auth status` timeout has none (the timeout is not configurable). It fails closed through the "unverified" path.
- **Expired login** probably still reports `loggedIn: true`. It is caught per Turn by the existing `authentication_failed` mapping.

## Suggested skills

`code-review` for the review pass.
