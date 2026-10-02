---
agent: reviewer
role: reviewer
tool: claude
task: task-0044
task_title: "Phase 5a: Claude subscription credential guard"
status: done
---

# task-0044 reviewer handoff

Verdict: **approve**. No blocking findings. I made no implementation edits, did not change task status, and did not commit. I read no `.inoai-connect*/.env` file and never printed `claude auth status` output.

Reviewed: `src/claude-runtime.ts` (untracked), `src/test/claude-runtime.test.ts` (untracked), and the `run()` tests in `src/test/transport.test.ts`. I checked them against the task file, the worker handoff `2026-10-02-2217_phase5a-0044_claude_worker.md`, spike section 5 (D3), Phase 5a step 7 and its test scenarios, and ADR 0002.

## D3 compliance

- **What passes:** connect accepts only when all of these hold: `loggedIn === true`, `authMethod === "claude.ai"` (`none` is refused through the sign-in-required path), `apiProvider === "firstParty"`, no own `apiKeySource` key (`Object.hasOwn`, so `null` or `""` are refused too), and exit code 0.
- **Malformed fields:** comparisons are strict and case-sensitive. A missing or non-string `authMethod`/`apiProvider` gives "could not be verified". An unknown `apiProvider` is "a cloud provider" and an unknown `authMethod` is "unsupported". I found no path that accepts a non-subscription credential.
- **`CLAUDE_CODE_OAUTH_TOKEN`:** refused when present in `process.env`, checked with `in` only. An empty value is also refused. The variable is never read, printed, or stripped, and the test asserts the env is unchanged.
- **Mapping checked against the CLI code:** I read only program code from the installed 2.1.287 binary, using `strings` over the Mach-O. Its auth-token resolver checks `ANTHROPIC_AUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN`, the FD/CCR token file, apiKeyHelper, profile, and finally claude.ai.
  - Any source other than `claude.ai` or `none` becomes `authMethod: "oauth_token"`, and `apiKeySource` is set whenever an API-key source or `ANTHROPIC_API_KEY` exists.
  - So a `CLAUDE_CODE_OAUTH_TOKEN` supplied through a settings `env` block reports `oauth_token` and is refused. That confirms the worker's fixture.
  - No credential file, settings, or keychain was read.

## Secrecy

- Only `loggedIn`/`authMethod`/`apiProvider`/`apiKeySource` are destructured. Identity fields and `projectsDirectory`/`configDirectory` are dropped.
- A `JSON.parse` failure maps to a fixed message. Every refusal text is a fixed label.
- stdin and stderr are ignored and there is no shell.
- **Fails closed:** I ran an ad hoc fake in the scratchpad that emits more than 70 KiB. The built guard returned "could not be verified". The 10 s timeout follows the same `fail()` path.

## Startup ordering

- In `run()`, the `ClaudeRuntime.connect` error goes through `instance.release()` and is rethrown before `startTransport`. `createChatTransport` only constructs the client; it does not log in.
- The `run()` refusal test asserts no Discord login, the lock released, and 0 Events.
- Nothing modifies the env or settings.

## Per-Turn check

- **Trigger:** init `apiKeySource !== "none"`, which includes a missing field.
- **What happens:** the CLI gets SIGKILL immediately and the rest of the stream is drained unused, so nothing is yielded and no denials are counted. The Turn throws `RuntimeFailure("authentication")` with replaySafe=false.
- **Single attempt:** `runRuntimeTurn` retries only replay-safe `pre_start`/`timed_out`, so this Turn is attempted once (tested: attempts 1, Claude login notice).
- **Not replay-safe is correct under ADR 0002:** after init, nothing proves the request had no side effects.
- **Session state is acceptable:** marking the session `persisted` matches restart behaviour. The worst case is `session_missing`, after which the owner runs `/inoai reset`. Both outcomes fail closed.

## run() tests

- They are realistic. A fake `claude` on a PATH containing only its own bin answers `--version`, pretty-printed `auth status --json`, and `-p`. The transport is supplied.
- The success test reaches the real provider switch, `ClaudeRuntime.connect`, `claudePermissionDenialNotifier`, and the task-0043 notice. It shows one `approval_unsupported` Event, `agent_provider` `claude`, and no sentinel or tool input in sends, logs, or events.
- PATH, `CLAUDE_CODE_OAUTH_TOKEN`, cwd, and exitCode are restored, and each one is deleted if it was originally unset.
- None of the tests can reach the real CLI.

## Findings

1. **Low (optional, non-blocking).** `src/test/claude-runtime.test.ts:225-259` has no regression test for the 64 KiB `auth status` cap (`src/claude-runtime.ts:243`). Fix: add a refusal case whose fake writes about 70 KiB of otherwise-valid subscription JSON, expecting `/could not be verified/`. My ad hoc check shows the behaviour is already correct.
2. **Informational / residual, outside the task's scope.**
   - The per-Turn init `apiKeySource` reflects only the API-key source. An auth token or cloud provider added to the owner's or project's Claude settings *after* startup would not show up in it. The task specifies exactly this per-Turn signal, and spike section 5 documents it, so I am not counting this against task-0044.
   - `readAuthStatus` relies on the inherited cwd (`src/claude-runtime.ts:235`). `run()` currently makes that equal to the session project path, because `dirname(runtimeHome) === process.cwd()`. Passing `cwd` explicitly would make the project/local settings evaluation robust if that coupling ever changes.

## Checks

- `npm test`: 113 tests, 113 pass, 0 fail.
- `npm run typecheck` and the build: clean.
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on the untracked src/docs files (claude-runtime.ts, claude-runtime.test.ts, ADR 0007/0008, the spike doc): no output.
- `git diff --cached`: empty.
- Flakiness: `node --test dist/test/claude-runtime.test.js dist/test/transport.test.js` ran 4 times, 40/40 pass each time.
- I ran the built guard against the real CLI and printed only the verdict: "accepted".

## Suggested skills

`code-review` if a phase-wide review follows. None are needed to act on the optional Low item.
