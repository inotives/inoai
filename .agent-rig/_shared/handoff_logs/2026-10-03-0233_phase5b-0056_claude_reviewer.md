---
agent: reviewer
role: reviewer
tool: claude
task: task-0056
task_title: "Phase 5b: Integrated review and acceptance"
status: handoff
---

# task-0056 integrated review: Phase 5b OpenCode runtime

I reviewed the whole integrated diff against `main` on `feature/phase-5b`: 17 tracked files changed (+408/-41), plus the untracked files `src/opencode-runtime.ts`, `src/test/opencode-runtime.test.ts`, ADR 0009, the spike doc, and the task and handoff files. I made no implementation edits, did not change the task status, and committed nothing. I did not read any `.inoai-connect*/.env`, OpenCode config, DB, or credential. The only real CLIs I ran were `opencode --version` (v2.0.22) and `claude --version` (2.1.287).

## Verdict

No code defects, and nothing blocks acceptance. The code, tests, safety invariants, and Codex/Claude regression surface are clean. There are two Low docs items and a few Info notes. F1 is the expected phase-close README status update. Once F1 and F2 are applied (docs only, no re-review of code needed), the planner can mark task-0056 `done`. I left the status at `handoff` because these findings are still open.

## Findings

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| F1 | Low (phase close) | `README.md:5` | The status line still reads "Phase 5b (OpenCode) is in progress". | At phase close, change it to say Phases 1–5, 5a, and 5b are implemented, with Phase 5b adding OpenCode as a third runtime. |
| F2 | Low (docs) | `docs/phase-5b-opencode-cli-spike.md:95`, `:165`, `:173` | These lines still say that stdout/stderr rejection parity is "unknown, for task-0053 to verify". Task-0053's real check resolved it: 2 stdout `tool_use` rejection events equalled 2 stderr lines, and `external_directory` got its own stdout event. | Add a one-line "Resolved by task-0053" note at :95, drop "is unknown (see 4)" at :165, and remove or mark resolved open question :173. |
| I1 | Info | `docs/discord-codex-cli-harness-proposal.md:104` | It says "OpenCode ignores `instructions` config" without a version. README :223 and the code comment (`src/opencode-runtime.ts:250`) say 2.0.22. The proposal OpenCode paragraph and plan-review 29 also do not mention D3, OpenCode's permissive default permissions. ADR 0009 ¶2 and README "Behavior" do document D3. | Optional: add "(2.0.22)", and one clause such as "inoai keeps OpenCode's permission policy, which is permissive by default (ADR 0009)". |
| I2 | Info | `docs/implementation-phases.md` Phase 5b task 3 | "resume with `--session` afterwards after checking the session exists" reads as a check on every resume. The code and spike check once per process for a session not yet seen to succeed (`src/opencode-runtime.ts:99`). This was raised before as the task-0050 I1 note. | Optional wording alignment. |
| I3 | Info | `src/test/transport.test.ts:681` | The comment says "An empty PATH", but PATH is a temp dir that contains no binaries. Behavior is correct, and the Claude test at :654 uses the same wording. | None needed. |
| I4 | Info (residual) | `src/opencode-runtime.ts:184-188` | The 5-minute idle timer refreshes only on stdout lines. OpenCode emits only completed parts, so a single tool step that stays silent for more than 5 minutes is killed as `timed_out` (not replay-safe). This matches the planned idle timeout and fails closed. | None. Revisit if long silent tool steps appear in practice. |

## Owner decisions (all honoured)

- **ADR 0009:** free Zen or the configured provider, with no model or credential guard. The argv has no model or provider flag (`:172`). There are no new `.env` keys, and `CLAUDE_MODEL` is ignored for opencode (`src/config.ts:41`, config test).
- **Parity minus the concurrency probe:** `src/index.ts` opencode branch has no `probeConcurrency`. The wiring test asserts the log line `OpenCode cross-session concurrency: unavailable; using global FIFO`.
- **`--standalone` per Turn:** `src/opencode-runtime.ts:172`, and the existence check at `:144`.
- **D1 persona:** a delimited stdin block on every Turn, re-read each Turn (`:251-253`). Test 1 asserts the exact stdin for Turn 1 and for Turn 2 after an edit.
- **D2 / task-0057:** provider-worded authentication and usage notices for all three providers, asserted through `ConversationWorker`.
- **D3:** the permissive default policy is kept and documented (ADR 0009 ¶2, README "OpenCode's default rules are permissive"). inoai neither loosens nor tightens it.

## Safety invariants (verified in code)

- **No elevation:**
  - The run argv is exactly `run --format json --standalone [--session <ses_id>]`, and the check is `api --standalone GET /api/session/<ses_id>`.
  - No `--auto`, `--yolo`, `--dangerously-skip-permissions`, or `--model`. A grep of src/ for these flags matches only comments and docs.
  - No `env` option, so the environment is inherited unchanged; test 1 asserts a sentinel and an identical key set.
  - No config writes, and no `OPENCODE_CONFIG_CONTENT`.
- **No shell:** every `spawn` call passes an argv array with no `shell` option, and the prompt goes on stdin. A test passes a prompt that starts with `--`.
- **No secrets:**
  - stderr is `ignore` for both the run and the check.
  - Only the `error.type` string and a denial count are read from events. Tool input and output are never kept.
  - The leak regex in the transport wiring test covers sends, the console, and a full dump of every SQLite table, with token literals planted in tool input, error text, and stderr. The opencode end-to-end denial test makes the same assertions.
- **Fail-closed denials, count only:**
  - Only stdout `tool_use` events with `status:"error"` and the fixed prefix are counted (`:229-230`). The listener runs at most once per Turn and its errors are swallowed (`:110-112`).
  - The result is one `approval_unsupported` Event (`denials=<n>`, `runtime:opencode`) and one fixed archived notice, with no approvals rows or controls.
  - The Claude notifier is byte-identical: the template with "Claude" reproduces the old constant, and the actor and SQL filter are unchanged apart from binding the provider as a parameter.
- **Replay rules:**
  - `pre_start` with replay-safe true happens only for a spawn failure (`child.pid === undefined`, `:113,179`) and for existence-check failures that are not SessionNotFoundError (`:103`). `closed` is also pre-run.
  - Every spawned run that does not answer is `timed_out`, `authentication`, `usage`, `cancelled`, or `uncertain`, and none of these is replay-safe. The precedence order matches the spike (`:122-127`).
- **Explicit reset:**
  - `session_missing` comes from SessionNotFoundError, from an orphaned `inoai-new:` key after a restart, and from a stored ID that fails `/^ses_[A-Za-z0-9]+$/`, which gets no CLI call.
  - A mismatched or malformed streamed ID stops the child with SIGINT and ends the Turn `uncertain`. It is never bound or aliased.
  - The provider mismatch path refuses before any runtime call.
- **Late rebind:**
  - `rebindAgentSession` (`src/database.ts:474-481`) is a compare-and-set from the placeholder. It requires `state='active' AND deleted_at IS NULL`, refuses `pending:`, and audits as `runtime:<provider>`.
  - It runs synchronously while the event is yielded (`src/runtime-turn.ts:47-52`), so a crash later in the Turn leaves the real ID.
  - A failed rebind throws, which ends the Turn `uncertain`, and the generator's `finally` stops the child.
- **FIFO:** the adapter allows one active Turn per key, and the worker's per-Session FIFO is unchanged. An OpenCode home is global FIFO.
- **Soft delete and audit:** there are no DELETE statements in the diff. Reset ends the session (the live smoke showed `ended` with `deleted_at` NULL).
- **Kill guard:** `stop()` signals only when `pid !== undefined && exitCode === null && signalCode === null`, with SIGKILL after 10 s. Cancel and close use SIGINT, and the idle timeout uses SIGTERM. The existence check is the active child while it runs, so cancel can reach it.

## Codex and Claude regression delta (confirmed)

- `src/codex-runtime.ts`, `src/claude-runtime.ts`, and their tests are untouched: the per-file test-name counts match `main`, 8 and 18.
- **The intended delta:** `ConversationWorker` now archives and sends `outcome.notice` for `authentication` and `usage` as well as `session_missing` (`src/conversation-worker.ts:16,181`). So Codex and Claude owners now see the following, where they used to get the generic "I couldn't complete that turn safely…":
  - "Codex sign-in needs attention. Run codex login locally…"
  - "Codex usage is unavailable…"
  - "Claude sign-in needs attention. Run claude /login locally…"
  - "Claude usage is unavailable…"

  The worker-level test asserts the exact texts.
- **Unchanged:**
  - The `failureNotice` templates (`src/runtime-turn.ts`). Only the authentication case gains the `authenticationNotice ??` prefix, and only OpenCode sets that field.
  - The uncertain and generic notices for the other kinds.
  - The FIFO fallback triggers (`uncertain`, `timed_out`, thrown errors).
  - The mismatch text: the article moved into the map, and the result is byte-identical.
- **The only other user-visible Codex/Claude change:** the config error text is now "AGENT_PROVIDER must be codex, claude, or opencode". This is intended.

## Scenario-to-evidence table

| Phase 5b scenario | Evidence |
|---|---|
| `AGENT_PROVIDER=opencode` validates; startup fails clearly without `opencode`, releasing the lock | config test "accepts the OpenCode provider…"; transport test "a missing OpenCode CLI fails startup…" (no login, lock gone, restart ok); live smoke validate |
| Answer; follow-up resumes the same session, including after restart | opencode tests 1 (final-step answer, `--session` resume), 3 (fresh runtime instance: checked once, then resumed); task-0052 real two-Turn restart check; live smoke a/b |
| `agent.md` reaches every Turn as a delimited block alongside native `AGENTS.md`; edits apply next Turn | opencode test 1 (exact stdin on both Turns, edited persona on Turn 2); spike §3 (AGENTS.md native, edits apply next run); live smoke e (model saw the block as "not a user message") |
| A vanished stored session → `session_missing` + reset notice, never a silent new session | opencode tests 4, 5, 14 (SessionNotFoundError, orphaned key, malformed stored ID, zero `--session` runs); conversation-worker "a missing runtime session fails once and tells the owner to reset" |
| Auto-rejected tool → one fixed notice + count-only Event; no controls, rows, or raw input | opencode tests 15, 16; transport OpenCode wiring test (denials=2, 1 notice, 0 approvals, leak scan); task-0053 real check (stdout 2 == stderr 2); live smoke c (denials=1, 0 approvals) |
| Rate-limit/auth → fixed OpenCode-worded notices (auth covers free tier); only never-started Turns retry; timeout/process loss not replayed | opencode tests 6 (13-case precedence table), 7 (never-spawned retry), 8 (timeout); conversation-worker provider-notice tests (3 providers × 2 kinds, attempts 1, replay_safe=false); runtime-turn override test. Not live (noted in 0055) |
| `/inoai cancel` and `/inoai reset` stop an active Turn and leave the Conversation usable | opencode tests 9, 10 (cancel before an event and during the check), 11 (close); provider-neutral worker reset and stop tests; live smoke d (cancel), e (reset, then a new session works) |
| A Codex- or Claude-bound thread in an OpenCode home → mismatch notice | conversation-worker "the mismatch notice names OpenCode…" (4 combinations) |
| Live bot: start, answer, continue, status, cancel, reset; Discord matches SQLite | task-0055 worker and reviewer handoffs: steps a–f pass, archive cross-checked, secret grep clean |

All the task-0052 test bullets are covered: interim tool-step text excluded (test 1), exit 0 with no final text → `uncertain` (test 6), a no-`sessionID` stream → `uncertain` (test 12), and a malformed streamed ID (test 13). Every scenario has evidence.

## Docs consistency

- These agree with the code: the phase doc (Phase 5b), the proposal (`.env` block, interface `session` event, OpenCode section), plan-review 29, `sqlite-schema.md:193` (placeholder lifecycle), ADR 0009 (with the D3 paragraph), README (setup commands and the `OpenCode CLI is unavailable` error match src), AGENTS.md, and CONTEXT.md (provider-neutral).
- No stale "OpenCode deferred" wording remains.
- Exceptions: F1, F2, I1, I2.

## Repo hygiene

- Nothing is staged (`git diff --cached --stat` is empty).
- No `.inoai-connect*` path or `.env` is tracked (`git ls-files` grep is empty). `.inoai-connect-claude` is ignored by `/.inoai-connect*/`, and `/.env` is ignored.
- No `inoai-*` dirs exist in `/tmp`, `/private/tmp`, or `$TMPDIR` (count 0). The smoke deployment `/tmp/inoai-phase5b-smoke.*` is gone.
- Processes: no `opencode run`, fake CLI, `dist/index.js`, or bot process is running. The only OpenCode process is the owner's `opencode serve --service`, started 2026-10-02 21:45, which I ignored.

## Check outputs

- `npm test` (build plus all tests): 144 tests, 144 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.
  - On `main` there are 122. The delta is +22: config +1, conversation-worker +3, transport +2, and the new opencode-runtime file 16.
  - No test was removed or renamed, and there is no `.skip`, `.only`, or `.todo`.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check` and `git diff main --check`: exit 0, no output.
- `git diff --no-index --check /dev/null <file>` for every untracked file (the src files, ADR 0009, the spike doc, the tasks, the handoffs): no whitespace output.

## Next

The planner applies F1 and F2 (and optionally I1 and I2), which are docs only. After that, task-0056 can be marked `done` without re-reviewing the code, and the planner can write the Phase 5b phase handoff. Commit and PR only when the owner asks.

## Suggested skills

None required.
