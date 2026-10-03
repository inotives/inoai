---
id: task-0060
title: "Phase 6: Review engine and validation"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0059
message: Review engine and deterministic validation; four review rounds, final
  clean; 176 tests
---








# Task

## Context

`src/database.ts` has `createMemoryReview`, `completeMemoryReview`, `messagesForMemoryReview`, and `listMemories`; `src/prompt-context.ts` has the secret-like filter. Validation rules are fixed by owner decisions Q2/Q3.

Sources: Phase 6 in `docs/implementation-phases.md`, the proposal's "Persisted inoai memory" and "Memory review loop" sections, `docs/sqlite-schema.md` (memory_reviews, memories, review notes), ADRs 0002, 0010, `docs/plan-review.md` decision 30, `CONTEXT.md` (Recap, Memory Review, Memory Signal, Manual Memory Entry). Live verification is Claude only; Codex is fake-tested; OpenCode skips reviews.

## Goal

Turn one Session's new archive range into a validated Recap and Memory changes committed atomically.

## Scope

- Owner decision D2: only Claude homes review in V1. Make the Codex adapter's `review` unavailable by default (keep the task-0059 implementation behind a constructor option that `index.ts` never sets), so the engine treats Codex like OpenCode. Add a test that the wired Codex runtime has no `review`.
- Select completed owner and agent Messages after the Session's last completed Recap, excluding inoai's fixed notices; redact secret-like text before sending.
- Split into chronological windows of at most `MEMORY_REVIEW_MAX_CHARS` with role labels; run one review call per window for bounded notes (held in memory only); run a final aggregation with the notes, active Memory (with origin and IDs), and recent agent-wide Recaps within a fixed character budget.
- Parse the JSON result using the spike's extraction rule; unparseable output fails the attempt.
- Validate each action: explicit signal must cite an owner-authored in-range Message containing a remember-style phrase; recurrence must cite ≥ 2 prior completed Recap IDs; `update`/`delete` must target an existing active `origin = review` Memory (manual → ignored "manual entry"); source IDs in range; body length cap; secret filter. Drop failures as `ignored` with a non-secret reason.
- In one transaction: complete the `memory_reviews` row with recap and through-message cursor, apply Memory adds/updates/soft-deletes with `origin = review`, `review_id`, `source_message_id`, and audit actor `memory-review`; record ignored outcomes without secret content.
- Tests with a fake runtime review method: windows, cursor only after commit, provenance, quoted/agent "remember" rejected, recurrence rule, manual read-only, secret filter, unparseable output, transaction rollback on failure.

## Planner Notes

Keep prompts fixed and documented in code; never include raw secret-like text in prompts, recaps, Events, or logs.

## Implementation Plan

1. Implement selection, windowing, prompts, parsing → verify: unit tests.
2. Implement validation and transactional apply → verify: full checks.

## Acceptance Criteria

- [ ] A seeded range produces one Recap and only validated Memory changes, atomically.
- [ ] Every invalid action is dropped as `ignored` with a non-secret reason.
- [ ] Manual entries are never changed by a review; cursor advances only on commit.

## Notes

- 2026-10-03 worker: Implemented `src/memory-review.ts` (`reviewSession`, `parseReviewJson`, `redactSecrets`). D2: Codex `review` is now gated behind a fourth constructor arg `enableReview` (default false); `index.ts` wires Codex via `createCodexRuntime(server)`, which never enables it. Ignored outcomes are recorded as one `memory_review_completed` Event per review (counts plus fixed reason codes), with no schema change. `update` supersedes: the old review entry is soft-deleted and a replacement carries fresh provenance. `delete` needs evidence: a cited owner Message in range, or ≥ 2 prior Recaps. Small exports added for the fixed notice texts (`fixedTurnNotices`, `providerMismatchNotice`, `runtimeFailureNotice`, `permissionDeclinedNotice`, `legacyApprovalNotice`) and for `secretLike`. Tests went from 159 to 170 (new `src/test/memory-review.test.ts`, 11 tests). Scheduling, attempts, the skip Event, and deferrals are left to task-0061.
- 2026-10-03 worker (review fixes): Fixed reviewer findings M1–M3 and L1–L2.
  - M1: the explicit signal must now be a request form at sentence start (after optional please/also/ok/… openers). A sentence ending in `?` is rejected unless it is a polite `can/could/would/will you … remember/note/keep in mind/take note` request. Single-quoted text, multi-line double or curly quotes, and an unclosed ``` fence (through end of text) are stripped first.
  - M2: a `reviewId` row whose `from_message_id` is not the first selected Message fails `stale_range` before any runtime call.
  - M3: `redactSecrets` also redacts the next non-blank line after a dangling separator, replaces the whole text if `secretLike` still matches across lines, and redacts PEM private-key blocks. `secretLike` now allows a closing quote before the separator and matches a PEM BEGIN line.
  - L1: the notice exclusions are built from a fixed table of all three providers (OpenCode's auth notice is now exported as `openCodeAuthenticationNotice`), every provider-mismatch pair, and `Legacy approval request redacted`.
  - L2: every data-section closing tag is escaped, case-insensitively.
  - Tests went from 170 to 176 (5 in memory-review, 1 in prompt-context). Residual risk: owner-pasted, unquoted text that starts a sentence with a request form still counts as a signal.
- 2026-10-03 worker (fix round 2): Fixed re-review findings L1–L3.
  - L1: `politeRequest` rejects a polite question whose next word is a question word or if/whether ("Can you remember what the port was?").
  - L2: `requestForm` accepts a sentence-initial bare "remember" with optional comma or colon, unless the next word is a question word or if/whether. It also accepts a short leading clause ending in a comma before "remember that/to" ("Going forward, remember that…"), and a sentence ending in ", remember that." or "— remember this.".
  - L3: `redactSecrets` re-checks a consumed value line for a dangling value, so `Authorization:\n  Bearer\n  xyz.abc` is fully redacted.
  - Regression cases were added inside the existing tests: 5 rejected, 5 accepted, and 1 redaction case. The total stays at 176 tests.
