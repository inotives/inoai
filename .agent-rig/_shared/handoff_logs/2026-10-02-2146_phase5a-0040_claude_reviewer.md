---
agent: reviewer
role: reviewer
tool: claude
task: task-0040
task_title: "Phase 5a: Claude provider configuration"
status: handoff
---

# task-0040 reviewer handoff

Reviewed against the task file, the worker handoff (`2026-10-02-2145_phase5a-0040_claude_worker.md`), Phase 5a in `docs/implementation-phases.md`, and the proposal's local configuration and "Claude runtime (Phase 5a)" sections. Scope: `src/config.ts`, `src/index.ts` (guard), `src/test/config.test.ts`, `.env.sample`, the proposal `.env.sample` block and paragraph, and the README validate sentence. No implementation edits made.

## Verdict

One finding. The task should go back to `in_progress` for a small fix.

## Findings

### F1 (Medium): `CLAUDE_MODEL` accepts values that start with a dash

- `src/config.ts:42`: `^[A-Za-z0-9._:\-\[\]]+$` lets `-` be the first character. I checked by hand in a temp runtime home: `CLAUDE_MODEL=--dangerously-skip-permissions` with `AGENT_PROVIDER=claude` passes `validate`. `-p` and `--settings` also match.
- Why it matters: the value will reach the `claude` CLI as an argv element. A value that looks like an option can be read as a flag rather than a model name, depending on how task-0042 builds argv (`--model X` or `--model=X`) and how the CLI parses its options. That conflicts with the acceptance criterion "No new key can alter runtime permissions, sandbox, approval policy, or credentials" and with AGENTS.md "Never silently elevate permissions". The current validation contract should not rely on the future adapter to be safe.
- Fix: require an alphanumeric first character, e.g. `^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$`. Add `--dangerously-skip-permissions` and `-p` to the rejection list at `src/test/config.test.ts:69`. Update the message to match if needed, e.g. "must start with a letter or digit and contain only ...". Defense in depth for task-0042: pass the value as `--model=<value>` or as a separate argv element after `--model`, and never through a shell.

## Checks

- `npm test`: 89 tests, 89 pass, 0 fail
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- Manual `node dist/index.js validate` in a scratchpad temp deployment folder (repo-root `.env` / `.inoai-connect*` not read or touched; temp folder removed):
  - blank `CLAUDE_MODEL`: valid
  - `claude-sonnet-5-5[1m]`: valid
  - `opus;x`: rejected with the `CLAUDE_MODEL` message
  - `--dangerously-skip-permissions`: valid (F1)
- Regex accepts `opus`, `sonnet`, `haiku`, `claude-opus-5-5`, `claude-sonnet-5-5[1m]`. It rejects whitespace, `;`, `$()`, `|`, backticks, `&`, `>`, and quotes. `[` and `]` are harmless because no shell is involved.

## Other criteria (pass)

- `AGENT_PROVIDER=claude` validates. An unsupported value fails and names `AGENT_PROVIDER`. Blank or absent `CLAUDE_MODEL` is accepted and `claudeModel` is left unset.
- No permission, sandbox, approval, or credential keys were added. Codex behavior is unchanged: the Codex path still has the same `CodexAppServer.connect` / `CodexRuntime` / `ApprovalRelay` construction, and a Codex home never exposes `claudeModel`.
- `src/index.ts:333`: the guard throws inside the existing `try`, so the `catch` calls `instance.release()` (runtime lock) and rethrows. It runs before `CodexAppServer.connect()` and before `startup`/transport login. `createChatTransport` only builds the Discord client object and does not log in. The concurrency probe and transport start come after this point, so nothing external is contacted.
- Style matches the surrounding validators. The tests are focused, use in-memory value maps, and do not touch any repository-root `.inoai-connect*`.
- Sample, proposal, and README edits are accurate. The README validate sentence names both providers, the optional model, and "does not contact Discord, Codex, or Claude".

## Judgment calls

1. **Unsupported-provider message now reads "AGENT_PROVIDER must be codex or claude".** Acceptable, and I recommend keeping it. Keeping the old "must be codex" text would be wrong once `claude` is valid. The acceptance criterion only requires the variable name, and no doc or test pins the old string (`docs/implementation-phases.md` only says an unsupported value "fails before startup"). I read "keep the exact error" as keeping the error's form.
2. **A malformed `CLAUDE_MODEL` is ignored in a Codex home.** Acceptable, and I recommend keeping it. The task says to "Ignore `CLAUDE_MODEL` for a Codex home", and the value is never passed anywhere in that home, so there is nothing to protect. Not a finding.

## Residual risk / test gaps (non-blocking)

- No test exercises the `run()` Claude guard and lock release. It is temporary (tasks 0041/0042 replace it), so I am not raising it as a finding. Whoever removes it should cover lock release for the real Claude construction failure.

## Next

Set task-0040 back to `in_progress`. A worker applies the F1 fix with regression cases, then re-review. Do not unblock downstream tasks until review is clean.

## Suggested skills

- `security-review` (argv-injection angle when task-0042 builds the `claude` argv)
