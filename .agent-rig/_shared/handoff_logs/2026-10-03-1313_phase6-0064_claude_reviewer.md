---
agent: reviewer
role: reviewer
tool: claude
task: task-0064
task_title: "Phase 6: Integrated review and acceptance"
status: handoff
---

# task-0064 integrated review (reviewer handoff)

**Verdict: code accepted. Docs need one small fix pass before phase close.** I found no code, safety, or chat-regression findings. Every Phase 6 scenario has evidence, and all offline checks pass (190/190 tests). Five Low docs inconsistencies remain, plus the README status line that the planner updates at close. I set status `handoff` rather than `done` because those doc items are not resolved yet. They are all doc-only, and none blocks the code.

I made no implementation edits; this handoff is my only change. I did not change task status and did not commit. The only real CLI run was `--version` (none was needed). I used no Discord and did not read any `.inoai-connect*/.env`. Scratch probes ran against `dist/` from the session scratchpad, each with its own temporary home, which I deleted.

Inputs read: AGENTS.md, the reviewer role, the handoff skill, tasks 0058–0065, all 27 `*phase6*` handoffs, the integrated diff vs `main` (19 tracked files, +478/−48) and the untracked files, Phase 6 in `docs/implementation-phases.md`, the proposal's runtime interface and memory sections, `docs/sqlite-schema.md`, plan-review decision 30, ADRs 0001/0002/0007/0010, the spike doc, README, and CONTEXT.

## Findings

All are Low and docs-only. Suggested owner: the planner at phase close, or reopen task-0062 as a doc pass with a quick re-review.

1. **Low: `docs/sqlite-schema.md:200` contradicts the owner decision.** It says "`origin` is provenance only: all active Memory has the same retrieval and review behavior". Line 199 and the code (`src/memory-review.ts:317`, `manual_entry`) make Manual Memory Entries read-only to reviews.
   **Fix:** "…same retrieval behavior; reviews may change only `origin = review` entries (Manual Memory Entries are read-only to reviews)."
2. **Low: the proposal's runtime interface omits the review method.** `docs/discord-codex-cli-harness-proposal.md:76-81` lists only `createSession`, `runTurn`, `cancel`, and `health`. Code adds the optional `review?(prompt, { signal }) -> text` (`src/agent-runtime.ts:16`). ADR 0001 says this interface is the seam.
   **Fix:** add `review(prompt) -> final text (optional; text-only throwaway session, ADR 0010; absent = reviews unsupported)`.
3. **Low: stale proposal wording at `docs/discord-codex-cli-harness-proposal.md:183`.**
   - "A Conversation without new archived messages receives no review" should say Agent Session (per-Session Recaps).
   - "the recap cursor advances only after the full range succeeds" should be qualified. With the 60-window cap, a review commits part of the range and a follow-up row reviews the rest. Suggested: "…advances only over the range a committed review covered; any remainder is reviewed next".
4. **Low: owner decision D3 (engine-detected explicit requests in aggregation, task-0065) is in no doc.**
   - Phase 6 task 3 (`docs/implementation-phases.md:232`), ADR 0010 and plan-review 30 describe aggregation as notes + Memory + Recaps only.
   - **Fix:** in task 3, add "plus the in-range owner Messages that pass the explicit-signal check (redacted, tag-escaped, bounded)". Optionally add one clause to plan-review 30.
5. **Nit: capital after a semicolon** at `docs/discord-codex-cli-harness-proposal.md:176`: "…throwaway-sessions.md)); Only Claude homes…". Fix: "; only Claude homes…" (or end the sentence with a period).

**README status line (expected at close, not a defect).** `README.md:5` still says "its code is complete and live Claude acceptance is pending". task-0063 is now done, so when the planner closes the phase, replace the whole line with:

> **Status:** Phases 1–6 (including 5a and 5b) are implemented: scaffolding, the SQLite archive and queue, the Discord transport, the Codex runtime, the end-to-end conversation worker, Claude CLI (Phase 5a) and OpenCode (Phase 5b) as further runtimes, and the silent Daily Memory Review (Phase 6; Claude homes only in V1). The Electron app and V1 hardening remain later work.

## Scenario → evidence

The "Test" column gives file:line for the test name. "Live" refers to the task-0063 re-run handoffs `2026-10-03-1305_phase6-0063-rerun_claude_worker.md` and `2026-10-03-1308_phase6-0063_claude_reviewer.md`.

| Phase 6 scenario (`implementation-phases.md:243-253`) | Evidence |
| --- | --- |
| A Session with no new Messages creates no Recap | `memory-review.test.ts:99` |
| Once per local date across restarts, with startup catch-up | `memory-review-scheduler.test.ts:112` |
| A Recap covers only Messages newer than the prior completed Recap | `scheduler.test.ts:112` (2nd cycle: `[completed, later, later]`); `memory-review.test.ts:353` |
| After a reset, the ended tail and the new Session are recapped separately | **Code by construction** (`memory-review-scheduler.ts:141` enqueues every non-deleted Session). **My probe:** after `resetSession`, Session 1 (ended, msgs 1–2) and Session 2 (active, same thread, msgs 3–4) got separate completed rows, and A's prompt held none of B's text. **Gap:** no committed test (follow-up F6). |
| Oversized range in chronological windows; cursor advances only on commit | `memory-review.test.ts:114`, `:163`, `:376`; `scheduler.test.ts:320` (follow-up row) |
| Owner "remember" becomes Memory with provenance; quoted or agent text does not | `memory-review.test.ts:163`, `:390`, `:535`, `:555`. Live: pnpm Memory with `origin=review`, `review_id=1`, `source_message_id=1`; quoted force-push and agent yarn not added |
| One-off item excluded; a pattern across ≥2 prior Recaps may be added | `memory-review.test.ts:205`. One-off exclusion is prompt-only, which README states. |
| Secret, transient, quoted, or unconfirmed claim ignored; Manual change ignored with a reason | `memory-review.test.ts:205` (`manual_entry`), `:273`, `:468`. Live: sk-test count 0 outside the seeded archive row |
| Chat at the scheduled time runs first; chat mid-review defers without an attempt | `scheduler.test.ts:167`, `:194`, `:225` (deferral cap) |
| A failed or unparseable review retries ≤3 times that day and sends no Discord message | `scheduler.test.ts:259`, `:301`; `memory-review.test.ts:273`; `scheduler.test.ts:194` (only the chat answer is sent) |
| Throwaway session with tools disabled, never the thread's own Session | `runtime-review.test.ts:94`, `:128`, `:166`–`:257` (Claude argv/fail-closed/abort/close), `:296`–`:374` (Codex), `:400` (OpenCode) |
| Codex and OpenCode homes skip and keep their cursors | `scheduler.test.ts:391`; `memory-review.test.ts:83` (wired `createCodexRuntime().review === undefined`, D2) |
| Stale `processing` returns to pending on restart; shutdown cancels cleanly | `scheduler.test.ts:337`, `:409` |
| Live seeded Claude review | task-0063 re-run 2/2. Init `tools: []`, `mcp_servers: []`, no `memory_paths`, `apiKeySource: "none"`; 0 tool_use/denials; no `pwned*` file; cursor 8; one Recap |

## Safety invariants (verified in the integrated diff)

- **No permission elevation for Turns.**
  - The chat Turn argv and code paths are unchanged.
  - The `runtime-turn.ts` diff is a type-only `Pick` plus an export alias.
  - `conversation-worker.ts` only adds the `finally` listener (skipped while stopping) and the setter.
  - Review flags only restrict: Claude `--tools "" --strict-mcp-config --safe-mode --system-prompt --no-session-persistence --permission-prompts none` (`claude-runtime.ts:196-202`). Codex `read-only` / `never` / `ephemeral`, disabled by default (`codex-runtime.ts:25-27`; `index.ts` `createCodexRuntime`).
- **No shell.** `spawn` runs without a shell; the prompt goes on stdin; stderr is ignored.
- **Fail closed on unsafe signals:**
  - an init with `memory_paths`, tools, or MCP servers;
  - `apiKeySource` other than `none`;
  - any `tool_use` block;
  - `permission_denied`;
  - non-empty `permission_denials`.
- **No secrets in prompts, Recaps, Memory, Events, or logs.**
  - `redactSecrets` covers the transcript, notes, Memory, Recaps, and explicit requests.
  - Bodies and the recap are checked again with `secretLike`.
  - Event details hold only counts, IDs, dates, and fixed codes.
  - The only log lines are the fixed `claudeReviewLeftoverWarning` and the scheduler's `onFailure` text.
- **No physical deletes.** There is no `DELETE FROM` in `src/`. Retired rows and superseded Memory are soft-deleted with `deleted_by`, and audit actors are `memory-review` / `memory-review-scheduler`.
- **Atomic commit; cursor moves only on commit.** `commit()` runs in `BEGIN IMMEDIATE` with a stale re-check and ROLLBACK on any error (`memory-review.ts:394-434`). The cursor is `MAX(through)` over completed rows only.
- **Chat is never delayed.**
  - `poke()` returns before the cycle while chat is busy, and aborts an active review.
  - A review never shares a lock with Turns.
  - A preemption is recorded as `memory_review_deferred` and uses no attempt.
- **Reviews are silent.** The scheduler holds no transport.
- **Codex and OpenCode skip with cursors kept.** The skip Event is recorded and nothing is enqueued.

## Chat Turn regression safety (all three runtimes)

- **Notice texts are byte-identical to `main`.** I checked with a scratch script against `git show main:` and the built `dist`:

  | Notice | Identical |
  | --- | --- |
  | Codex declined notice | true |
  | Claude/OpenCode declined template | true |
  | `legacyApprovalNotice` | true |
  | `fixedTurnNotices` | true |
  | OpenCode auth notice | true |
  | provider-mismatch template | true |
  | `runtimeFailureNotice` switch body | true |

- **FIFO is unchanged.** Claim order and modes are untouched.
- **`secretLike` is a strict superset of `main`.** The only additions are an optional `["']?` before the separator and a PEM alternation. Its only chat use is filtering in `prompt-context.ts:26,35`, so it can only filter more.
- **Existing tests are unchanged.** The test diffs only add tests and pass the scheduler clock to wired `run()` calls. No assertion was removed, and there is no `.skip`/`.only`/`todo`.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | **190 tests, 190 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** (main 144; +46) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` / `git diff main --check` | clean |
| `git diff --no-index --check /dev/null <f>` for all 42 untracked files | no whitespace output |
| Staged files | 0 |
| Tracked `.inoai-connect*` / `.env` | none. `.inoai-connect-claude/` is ignored and was not read. |
| Secret grep on untracked files | only fake test fixtures (`sk-test-…`, sample PEM in tests) and doc mentions |
| Stray processes | none from inoai (no `claude -p`, fake CLIs, `node --test`, `dist/index.js`, `opencode run`). The owner's `opencode serve --service` started Oct 2 21:45, before Phase 6, and is not inoai's. |
| `~/.claude/projects` review folders | 0 |
| `$TMPDIR/inoai-*` | **2 leftovers remain**: `inoai-review-scheduler-pFvMml` (12:22) and `-XuvC3v` (12:25). My full test run added none. |

### Scheduler temp-dir leftovers

- **The cleanup code is correct for ordinary failures.** `withHome` (`src/test/memory-review-scheduler.test.ts:65-68`) removes its dir in `finally`, and `until()` throws rather than hangs.
- **The leftovers point to a killed process.** One dir holds a partial delete (`agent.md` plus `-wal`/`-shm`, with no main db or `.env`); the other was never cleaned. Both suggest a test process killed during task-0061 development (12:22–12:25), where `finally` cannot run. They are not a code defect.
- **Contents:** a test-bootstrapped home with the template `.env` and fake seeded SQLite. I did not read the `.env`.
- **Removal:** I did not delete them because I did not create them. The manager can remove them with:

  ```sh
  rm -rf "$TMPDIR"inoai-review-scheduler-pFvMml "$TMPDIR"inoai-review-scheduler-XuvC3v
  ```

## Follow-ups for the planner handoff (non-blocking)

- **F1. Explicit-requests overflow.** Past the 4000-character `requestsBudget`, the newest requests are left out of `<explicit_requests>`, and the cursor still passes them.
  - Preferred fix: end the review range before the first request that does not fit, as the window cap does.
  - Alternative: keep the newest requests.
  - Also correct the task-0065 worker handoff's "wait for the next run" wording.
- **F2. Codex MCP-off verification before enabling D2.** Verify that a `thread/start` config override disables MCP and web search with real Codex. Revisit two related items at the same time: the strict item allowlist (`plan` or `contextCompaction` items would fail a review) and a `turn/start` timeout that cannot be interrupted.
- **F3. Notice drift on a provider or wording change.**
  - The `fixedNotices` table (`memory-review.ts:146-166`) is hard-coded to the current wording.
  - Archived notices with older wording would be reviewed as agent text. That is harmless, because agent text is never an explicit signal, but it adds noise.
  - The `:495` test catches drift between the table and the live runtimes, but not historical wording.
- **F4. `--safe-mode` drift.** Re-verify the init evidence on every Claude CLI upgrade. CLAUDE.md loading has no init field, so the backstop cannot detect it.
- **F5. The window step drops the explicit request** (3 of 3 haiku samples). Positive adds now depend on `<explicit_requests>`. Recurrence adds still depend on what the notes keep.
- **F6. Test gap: ended Session after a reset.** Add a scheduler test showing that an ended Session's completed tail and the new Session in the same thread get separate rows. Today only my scratch probe shows it.
- **F7. Phase 7 UI.** Handle completed `memory_reviews` rows with a NULL recap (`empty=1`) as "no reviewable content".
- **F8. Error text nit.** `memory delete` on an unknown id says "Manual Memory Entry not found" (`src/index.ts:306`), although the command deletes either kind.
- **F9. Concurrency residual.** In global-FIFO Claude homes, a preempted review's process can overlap a new Turn for its SIGINT plus up to the 2 s exit grace. The quota cost is negligible.
- **F10.** Remove the two leftover temp dirs above.

## Next

1. The planner (or a task-0062 doc reopen) applies findings 1–5 and the README status line.
2. A quick doc-only re-review follows.
3. The planner marks task-0064 `done` and writes the planner phase handoff with F1–F10.

Commit or PR only on the owner's request.

## Suggested skills

- `code-review` (doc-only re-review)
