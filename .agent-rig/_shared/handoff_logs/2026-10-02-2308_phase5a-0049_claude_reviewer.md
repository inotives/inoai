---
agent: reviewer
role: reviewer
tool: claude
task: task-0049
task_title: "Phase 5a: Integrated review and acceptance"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0049: Phase 5a integrated review and acceptance

## Verdict

**Clean.** There are no code or documentation findings at Medium or above. One Low hygiene item (H1) needs a one-command cleanup outside the repo. The Info notes below are non-blocking. I made no implementation edits, did not change any task status, staged nothing, and committed nothing. The only real-CLI call was `claude --version` (2.1.287). I did not contact Discord or read any `.inoai-connect*/.env`.

## Scope read

`AGENTS.md`, reviewer role files, handoff skill, tasks 0039–0049, all 32 `*phase5a*` handoffs, Phase 5a in `docs/implementation-phases.md`, the proposal's "Claude runtime (Phase 5a)" section, `docs/plan-review.md` decision 28, ADRs 0007 and 0008 (and 0002/0003 by reference), `docs/phase-5a-claude-cli-spike.md`, `README.md`, `CONTEXT.md`. Integrated diff: `git diff main` (24 tracked files, +958/−76) plus untracked `src/claude-runtime.ts`, `src/test/claude-runtime.test.ts`, the spike doc, ADRs 0007/0008, and task/handoff files.

## Findings

- **H1 (Low, hygiene).** A stale fixture folder `$TMPDIR/inoai-fake-claude-lQVuC9/` (mtime 22:33, from an earlier session around task-0044/0045) holds `fake-claude.mjs` and an auth-failure `scenario.json`. It has no secrets. The current suite cleans up after itself: my 23:06 run left nothing behind. Fix: `rm -rf "$TMPDIR"inoai-fake-claude-lQVuC9`. No code change needed.
- **I1 (Info, docs).** `docs/discord-codex-cli-harness-proposal.md:63` still says "the deployment folder is the Codex project path", and line 88 still says "A future adapter must deliberately define…". Both are true for Claude too, since it uses the same project path and receives `agent.md` via `--append-system-prompt`, but the wording is Codex-only. Optional rewording: "the agent runtime's project path".
- **I2 (Info, docs).** `README.md:5` says "Phase 5a (Claude runtime) is in progress". Update it when the planner closes the phase.
- **I3 (Info, accepted earlier).** The wrong-bot text also appears for human-created threads (`conversationOwnedByBot` false). This was already accepted as Low in the task-0045 review.
- **I4 (Info, evidence).** Two scenario clauses have only indirect evidence. See the table rows marked "partial".

## Scenario-to-evidence table

| # | Scenario (implementation-phases.md Phase 5a) | Evidence | Status |
|---|---|---|---|
| 1 | `AGENT_PROVIDER=claude` validates; unsupported provider / malformed `CLAUDE_MODEL` fails before startup | `config.test.ts` 51, 58, 68, 83, 89 (rejects before lock) | Evidenced |
| 2 | Startup succeeds on subscription login; refuses and names the source for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`, cloud provider, profile | `claude-runtime.test.ts` 215, 225, 261 (presence-only env check), 278 (per-Turn init `apiKeySource`); `transport.test.ts` 738, 755; live startup accepted (task-0048); 0044 reviewer real-CLI verdict "accepted" | Evidenced (non-subscription shapes from CLI bundle fixtures, as the spike documents) |
| 3 | Normal question answers; follow-up resumes the same Session, including after restart | `claude-runtime.test.ts` 84 (`--session-id` then `--resume`, same UUID); 366 (restarted runtime uses `--resume` only, never `--session-id`); live steps a/b | Partial: the restart success path is not exercised end to end. The restarted runtime's argv is proven, and the success classification is shared |
| 4 | `agent.md` reaches every Turn without replacing the default prompt; a local skill / read-only MCP tool is available | argv test 84 (`--append-system-prompt=` and `--system-prompt-snapshot off` every Turn, edited text on resume); 0042 worker real-CLI ZEBRA→QUOKKA check passed; spike §3 (default prompt kept); argv asserts no `--mcp`/`--settings`/`--bare`/tools flags on live Turns | Partial: skill/MCP availability rests on unchanged owner config (no restricting flags) and the spike's init listing `skills`/`mcp_servers`, not a live tool call |
| 5 | Permission prompt denied without hanging; fixed notice; no control, pending approval row, or raw input stored/sent | `claude-runtime.test.ts` 446, 525; `transport.test.ts` 755; live step c (`approval_unsupported denials=1`, `approvals`=0 rows, no `probe.txt`) | Evidenced |
| 6 | Expired auth / exhausted usage produce Claude-worded notices with the Claude login hint | `claude-runtime.test.ts` 158 (signal→kind mapping); `runtime-turn.test.ts` 85 (notices name runtime + `claude /login`) | Evidenced offline (live shapes unknown per spike §7) |
| 7 | Pre-start retries ≤3; timeout/process loss after start not replayed | `claude-runtime.test.ts` 190 (spawn fail `pre_start` replay-safe), 321 (idle timeout not replay-safe), 158 (`uncertain`), 413; shared `runtime-turn` retry tests | Evidenced |
| 8 | `/inoai cancel` and `/inoai reset` stop an active Claude Turn; Conversation usable | `claude-runtime.test.ts` 333, 413, 428; live steps d/e | Evidenced |
| 9 | Codex-bound thread in a `claude` home refuses with fixed notice; reset then starts a Claude Session | `conversation-worker.test.ts` 260, 313 | Evidenced offline (not live, per 0048) |
| 10 | Probe enables per-session concurrency only on overlap; sequential/failed runs keep global FIFO without dropping Messages | `concurrency-probe.test.ts` 50, 119, 138, 156, 171, 195, 212; live log "Claude cross-session concurrency: enabled" (task-0048) | Evidenced |
| 11 | Token-shaped literal never copied to SQLite/logs/Discord beyond the archived owner Message | `claude-runtime.test.ts` 84 (`sk-ant-…` in tool input/denial/result not yielded), 278, 446 (`sk-test-…`, `ghp_…` absent from SQLite/Discord); stderr ignored on every spawn; 0048 reviewer secret grep of archive clean | Evidenced |
| 12 | Live: start thread, answer, continue, status/cancel/reset; Discord matches SQLite | task-0048 worker and reviewer handoffs, steps a–f | Evidenced |

Tasks 1–12: each is implemented and reviewed (tasks 0039–0048 all `done` with clean final reviews). Task 1 → spike doc. Task 2 → `config.ts`, `.env.sample`. Task 3 → `displayName`/`loginHint` and the `index.ts` switch. Tasks 4/5 → `claude-runtime.ts`. Task 6 → `claudePermissionDenialNotifier`. Task 7 → `connect()` and the per-Turn init guard. Task 8 → `conversation-worker.ts` mismatch branch. Task 9 → `probeClaudeConcurrency`. Task 10 → `conversationOwnedByBot`. Task 11 → README. Task 12 → task-0048.

## Safety invariants (integrated code)

- **No elevation.** Live argv is `-p --output-format stream-json --verbose --include-partial-messages (--session-id|--resume) <uuid> --append-system-prompt=<agent.md> --system-prompt-snapshot off --permission-prompts none [--model=<m>]`. Probe argv adds only restricting flags (`--no-session-persistence --tools "" --strict-mcp-config --model=haiku`). No bypass, allow, settings, or permission-mode flags. The prompt goes on stdin.
- **No shell.** Every `spawn` uses an argv array with no `shell` option (`claude-runtime.ts:51,144,235`; `concurrency-probe.ts:167`). stderr is ignored.
- **Secrets.** Auth-status parsing keeps four fields and drops email/org. Refusal labels are fixed strings. The denial Event holds a count only. The mismatch notice uses a fixed provider map.
- **Credential guard (D3).** Startup checks: CLI present, `CLAUDE_CODE_OAUTH_TOKEN` presence, `auth status` with no `apiKeySource` key, `apiProvider=firstParty`, `authMethod=claude.ai`, `loggedIn`, clean exit. Unverifiable states fail closed. Per Turn, a non-`none` init `apiKeySource` triggers SIGKILL and `authentication`, which is not replayed.
- **Fail-closed approvals (ADR 0007).** The CLI denies prompts. inoai only counts denials and posts the fixed notice, best-effort, without changing the Turn outcome.
- **Replay (ADR 0002).** Only `pre_start` with `replaySafe=true` (spawn failure, or exit before init) is retried. Timeouts, uncertain outcomes, cancels, `session_missing`, and credential refusals are not.
- **Explicit reset.** `session_missing` is never recreated or replayed. A provider mismatch never starts or resumes the runtime. Reset creates a pending Session with the configured provider (`index.ts:146`).
- **FIFO per Session.** `active` map guard in `runTurn`/`resumeSession`. The worker queue is unchanged.
- **Soft-delete/audit.** No physical deletes. Actors are `runtime:claude` and `runtime:${agent_provider}`. Reset ends the Session without deleting it (live step e).
- **Kill guard.** `killProbe` skips children without a pid. Probe folder removal is literal-path and non-recursive `rmdir`, only when the folder is empty except for `memory/`.

## Codex regression safety

The Codex notice texts are byte-identical through the `failureNotice` template (`Codex`/`codex login`). The concurrency log text is unchanged. `ApprovalRelay` is unchanged; only a new exported function was added. The probe wiring is equivalent: a supplied runtime gives `false`, otherwise `probeCodexConcurrency`. `CodexRuntime` gained only two readonly fields. The default actor `runtime:codex` is unchanged. The wrong-bot text is a deliberate task-10 change that applies to both providers. All existing Codex tests pass.

## Docs consistency

The phase doc, proposal Claude section, plan-review 28, ADRs 0007/0008, spike doc (session_missing superseded note, tools flag resolved), README Claude section, and AGENTS.md agree with the code and with each other. A grep for stale "Claude deferred", "future Claude", "Codex-only", or "non-Codex adapters" wording found nothing beyond I1/I2. Agent SDK mentions appear only as the rejected alternative and the policy note.

## Check outputs

- `npm test`: tests 122, pass 122, fail 0, cancelled 0, skipped 0 (≈7.2 s).
- `npm run typecheck` (`tsc --noEmit`): clean.
- `npm run build` (`tsc -p tsconfig.json`): clean.
- `git diff --check`: rc 0. `git diff main --check`: rc 0.
- `git diff --no-index --check /dev/null <file>` for every untracked file: no whitespace errors.
- `git diff --cached`: empty (nothing staged).
- `git status --ignored --short`: ignored entries are `.inoai-connect-claude/`, `dist/`, `node_modules/`. `git ls-files` shows no `.env` or `.inoai-connect*` tracked. `.gitignore` covers `/.env`, `/.inoai-connect*/`.
- Temp folders: no `/tmp/inoai-*` (the smoke folder was removed). `$TMPDIR/inoai-*`: only H1. `~/.claude/projects/` has no smoke or probe folders left.
- Processes: no `claude -p`, `node dist/index.js`, fake-claude, or `codex app-server` running.
- `claude --version`: 2.1.287 (Claude Code).

## Next steps for planner

1. Remove H1, then mark task-0049 `done`.
2. Optionally reword I1 and update README status (I2) when closing the phase.
3. Write the planner phase handoff. Commit or PR only on the owner's request.

## Suggested skills

None required.
