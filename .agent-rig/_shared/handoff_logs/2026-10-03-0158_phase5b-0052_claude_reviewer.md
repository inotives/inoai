---
agent: reviewer
role: reviewer
tool: claude
task: task-0052
task_title: "Phase 5b: OpenCode runtime adapter"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0052 reviewer handoff

This was an independent review. I made no implementation edits and did not change the task status. Nothing is staged or committed. I did not read any `.inoai-connect*/.env`, OpenCode config, OpenCode DB, or credential. The only real CLI call was `opencode --version`, which returned v2.0.22.

**Verdict:** no blocking defects. There are two Low hardening findings (L1, L2) with small fixes, and two Low documentation and planner items (L3, L4). I recommend one short worker pass for L1 and L2 with regression tests, then re-review. L3 and L4 can go to the planner.

## Findings

**L1 (Low): an answer with no streamed `sessionID` silently starts a new OpenCode session each Turn.**
- Location: `src/opencode-runtime.ts:97`.
- Success requires only exit 0, no error, no mismatch, and non-blank text. It does not require `session.opencodeId`.
- Probe: a fake whose events lack `sessionID` produced `answer` twice. Both runs used plain `run --format json --standalone` with no `--session`, so context was silently lost. That breaks the explicit-reset principle (proposal §4).
- Real 2.0.22 always sends `sessionID` (spike §1), so this is hardening only.
- Fix: add `&& session.opencodeId` to the success condition so that case falls through to `uncertain`. Add a fake-CLI regression test.

**L2 (Low): the streamed `sessionID` is not validated before it reaches argv, the URL path, SQLite, or the alias map.**
- Locations: `src/opencode-runtime.ts:183-187`; `125` (`/api/session/${id}`); `153` (`--session <id>`).
- Any string is accepted. For example, `--…` would be parsed as an option and `../x` would change the API path. Line 186, `this.sessions.set(event.sessionID, session)`, also overwrites any existing state for that ID.
- The source is the trusted CLI, so the risk is low, but the check costs little.
- Fix: accept only `/^ses_[A-Za-z0-9]+$/` for both the streamed ID and an ID resumed from SQLite. Treat anything else as `uncertain`, or as `session_missing` on resume, and add a test.

**L3 (Low, docs): the new persistence lifecycle is not documented.**
- `docs/sqlite-schema.md` and the proposal's "Dynamic CLI runtime" interface (`docs/discord-codex-cli-harness-proposal.md:76-80`) do not describe it.
- For OpenCode, `agent_session_id` now goes `pending:` → `inoai-new:<uuid>` → streamed `ses_…`.
- The update is a compare-and-set rebind with actor `runtime:<provider>`, driven by the provider-neutral `{type:"session"}` event.
- AGENTS.md asks for the schema doc to be read before persistence changes. Planner or docs task.

**L4 (Low, planner decision): after an uncertain first Turn with no events, the next Turn behaves differently depending on whether inoai restarted.**
- Same process: `opencodeId` is undefined, so the next Turn starts a fresh OpenCode session.
- After a restart: the leftover `inoai-new:` key gives `session_missing` (`src/opencode-runtime.ts:72,81`).
- Neither case loses context the owner saw. A placeholder can only survive if no event with a `sessionID` was ever received. The rebind happens synchronously on the first such event, so no answer can have been delivered under a placeholder.
- The window that can strand a placeholder is OpenCode's 0.3 s to 4 s gap before its first event, when OpenCode may already have stored the uncertain user message.
- The restart behavior fails closed and is justified under the explicit-reset principle, matching the Claude precedent.
- The in-process fresh start drops that possibly recorded uncertain message without asking for a reset. Recommendation: accept and document both behaviors. Optionally, the planner could make the in-process case fail closed too.

## Shared seam review (no defects)

- **Codex and Claude unchanged.** Only `src/opencode-runtime.ts:187` yields `{type:"session"}`. The only `runTurn` consumer is `src/runtime-turn.ts:45`, and its `progress` and answer branches are unchanged.
- **Rebind query** (`src/database.ts:475-481`):
  - It is a compare-and-set on `agent_session_id = fromId`, and refuses `pending:` values.
  - It requires `state='active' AND deleted_at IS NULL`, so a reset or ended session is never rebound and no row is deleted.
  - It sets `updated_by = runtime:<agent_provider>` (`src/runtime-turn.ts:49-51`).
- **Second session event.** If a runtime yields `session` twice, the second compare-and-set misses and the Turn fails closed.
- **Unique-index collision**, probed by rebinding to the ID of an ended session: SQLite throws, `failureKind` maps it to `uncertain` (not replay-safe), the for-await `return()` runs the adapter's `finally`, the child was confirmed dead, and the DB keeps the placeholder.
  - Residual risk: in-process the adapter still aliases the colliding ID. That needs OpenCode to issue a duplicate ID, which is practically impossible. L2's validation does not cover it, so I note it as residual only.
- **Crash safety.** The rebind happens mid-Turn on the first event, so a crash later in the Turn still leaves the real ID in SQLite.
- **Fit with ADR 0001.** One union member plus one compare-and-set helper is the narrowest provider-neutral seam I can see. The alternatives (a DB callback in the adapter, or pre-assigned IDs, which the free tier refuses) are wider or unworkable.
- **Cancel keys.** `ConversationWorker.activeAgentSessionIds` holds the key passed to `runRuntimeTurn` (the placeholder on a first Turn). That matches the adapter's `active` key, so cancel and reset reach a first Turn.
  - The worker's note holds: a `ses_` alias is not guarded during a placeholder-keyed Turn. That is unreachable because the worker runs one Turn per Session in FIFO order.

## Other checks (no defects)

**Argv and environment**
- No shell. The run is exactly `run --format json --standalone [--session id]`, and the check is `api --standalone GET /api/session/<id>`.
- No model, auto, yolo, dangerously, fork, or continue flag. No `env` option, so the environment is inherited unchanged.
- stderr is ignored and nothing writes config. The persona block plus the prompt go on stdin, and the persona is refreshed from `resumeSession` each Turn.

**Failure precedence**
- The order is spawn `pre_start`(true), then `timed_out`, then `authentication`, then `usage`, then `cancelled`, then `uncertain`.
- Before the run: the check's `session_missing` and `pre_start`(true), and an orphaned key gives `session_missing`.
- Exit 130 without a cancel is `uncertain`, and exit 0 without final-step text is `uncertain`. This matches spike §6 and ADR 0002.

**Existence check**
- It runs once per process for unseen IDs, and the ID is marked verified on a check pass or on an answer.
- It is bounded to 10 s with SIGKILL, output is capped at 64 KiB, and it only issues a GET. A cancel or close during the check is handled.

**Process control**
- The kill guard (pid, exitCode, and signalCode), SIGINT cancel, SIGTERM then SIGKILL on idle timeout, and `close` are all correct.

**Tool data**
- Nothing from `tool_use` is kept. Tests assert the secret is absent from events, sessions, messages, events, Discord, and logs.

## Notice reachability (planner decision; not introduced by 0052)

- `ConversationWorker` uses `outcome.notice` only for `session_missing` (`src/conversation-worker.ts:180-181`). Authentication and usage outcomes get the generic `failureNotice`, so the `displayName`/`loginHint` text never reaches Discord.
- History:
  - Phase 5 (`29967fe`) posted only the generic and uncertain notices.
  - Phase 5a (`1d5d20a`) added the `session_missing` passthrough only.
  - So this behavior predates 0052.
- It contradicts the Phase 5a scenario ("Claude-worded notices with the Claude login hint", `docs/implementation-phases.md:183`) and the Phase 5b scenario ("OpenCode-worded notices", `:217`). Unit tests check only `runRuntimeTurn`'s returned notice (`src/test/runtime-turn.test.ts:92-99`, `claude-runtime.test.ts:312`).
- Recommendation:
  - The planner decides whether to pass `outcome.notice` through for `authentication` and `usage`. It is fixed, provider-worded text with no secrets, so passing it through is low risk. The alternative is to amend both scenarios.
  - If it is passed through, the OpenCode authentication wording should also cover a free-tier refusal, as spike §"Free-tier risk" recommends.
  - Either way, do it as its own small task with a worker-level test, not as part of 0052.

## Verification

- `npm test` (build + all): 137 tests, 137 pass, 0 fail, 0 skipped, 0 todo. This also passed while running in parallel with 6 OpenCode-file runs.
- Counts reconcile:
  - HEAD had 122 tests. Task-0051 added 3 (config, conversation-worker, transport), giving 125. Task-0052 added 12 (11 in `opencode-runtime.test.ts`, 1 in transport), giving 137.
  - Comparing test names per file against HEAD, none were removed or renamed, and there is no `.skip`, `.only`, or `.todo`.
- `npm run typecheck`: clean. `npm run build`: clean (part of `npm test`).
- `git diff --check`: clean.
- `git diff --no-index --check /dev/null` on both new files: no whitespace output.
- `dist/test/opencode-runtime.test.js`: 8 sequential runs at 11/11, plus 6 parallel runs alongside the full suite at 11/11. No flakes.
- Probes (scratch fake CLI, removed afterwards) confirmed L1, and confirmed the collision path gives `uncertain` with the child stopped and the DB unchanged.
- No stray `opencode` or fake processes and no `inoai-*` temp dirs remain.
- The worker reported its one real two-Turn check session deleted: `session delete` exited 0 and the follow-up GET exited 1. I did not re-query, because sessions are project-scoped and I did not touch OpenCode state.

## Suggested skills

`code-review` for re-review after the L1 and L2 fix pass.
