---
agent: reviewer
role: reviewer
tool: claude
task: task-0062
task_title: "Phase 6: README Memory Review"
status: handoff
---

# Reviewer handoff: task-0062

Verdict: **changes requested** (1 medium, 3 low). The worker's facts are otherwise accurate against the code. Docs-only diff to `README.md`; `git diff --check` clean. No `.env` read.

## Verified correct

- Keys and validation: `MEMORY_REVIEW_TIME` (HH:MM, `.env.sample` `06:00`) and `MEMORY_REVIEW_MAX_CHARS` (positive integer) match `src/config.ts:45-50` and `.env.sample:8-9`.
- Signal examples "remember that…", "please note…", "keep this in mind" match `requestForm` in `src/memory-review.ts:44-48`. Quote, fence, and inline-code stripping matches `hasMemorySignal` (`:115-127`). The unquoted-paste residual matches the comment at `:37-38`.
- Delete evidence (a cited owner Message in range, or at least 2 prior Recaps): `validateAction` `:309-313`. Update uses the add-level signal and recurrence check (`:321-322`) and supersedes (soft-delete plus new row, `:405-408`). Manual entries are rejected with `manual_entry` (`:303`).
- Scheduler (`src/memory-review-scheduler.ts`): one `memory_review_cycle` per local date; startup poke plus a 60 s timer (catch-up and wake); `chatBusy` gate; preemption returns the row to `pending` without an attempt; `maxDeferralsPerDay = 5` then `nextCycleTime`; `retryDelayHours = [1, 2, 4]` then `failed` until the next cycle re-arms it; no runtime.review, so `memory_review_skipped` is recorded and nothing is enqueued (cursor unchanged).
- Claude flags: `--no-session-persistence`, `--tools ""`, `--strict-mcp-config`, `--safe-mode`, `--system-prompt reviewInstructions`, `mkdtemp` cwd. Fail-closed when init reports tools, MCP servers, or memory paths (`src/claude-runtime.ts:194-235`). The CLAUDE.md/skills/plugins/hooks/memory claim matches ADR 0010.
- Codex: `enableReview` defaults false, never enabled (`src/codex-runtime.ts:21-26`, `src/index.ts:41-42`). OpenCode: `review = undefined`.
- `npm start -- memory list` prints JSON `MemoryRecord` rows including `origin`, `review_id`, and `source_message_id`. `memory delete` soft-deletes any active Memory (`src/index.ts:305-307`), so "removes either kind" is correct.
- Data flow: transcript, memory lines, and recap lines all pass `redactSecrets`, and the marker `[redacted: secret-like text]` matches `:30`. Prompt, notes, and reply are not stored (`:15`).
- The anchor `#daily-memory-review` resolves, and the ADR 0010 link target exists. No secrets or real IDs.

## Findings

1. **Medium, README.md:5 (Status line).** It says "Phases 1–6 … are implemented" while task-0063 (live seeded Claude acceptance) and task-0064 (integrated review) are both `blocked`. Phase 6 acceptance requires the live run (`docs/implementation-phases.md:240`). Suggested wording: "Phases 1–5, 5a, and 5b are implemented … Phase 6 adds the silent Daily Memory Review (Claude homes only in V1); its code is complete and live Claude acceptance is pending. The Electron app and V1 hardening remain later work." The planner switches it to "Phases 1–6" after task-0064 passes. (The worker correctly avoided claiming "live-verified" in the new section, which should stay that way until task-0063 is done.)
2. **Low, README.md:140 ("agent replies … do not become Memory").** This is overstated. Agent text can never be the explicit signal, but a recurrence-based add (≥2 prior Recaps) may cite any in-range Message, agent ones included, as its source (`memory-review.ts:309,319-322`). Also, "one-off requests do not become Memory" relies only on the prompt and is not enforced deterministically. Suggested wording: "Quoted, fenced, or inline-code text and agent replies never count as your request, and secret-like text is always dropped; the model is told to leave out one-off requests."
3. **Low, README.md:218 (Claude › Behavior).** "Your Claude settings, MCP servers, skills, and permission rules apply unchanged" now reads as covering reviews too, which contradicts the Runtime support bullet. Scope it to Turns, e.g. "…apply unchanged to Turns; Memory Reviews run without them (see [Daily Memory Review](#daily-memory-review))."
4. **Low, README.md:147 ("A review starts only when no chat Message is waiting").** `chatBusy` also blocks while a Turn is processing. Suggest "when no chat Message is waiting or being answered".

Informational, no README change needed: `memory delete` on an unknown id errors with "Manual Memory Entry not found" even though it deletes either kind (`src/index.ts:306`). This is a code text nit, outside this task's scope.

## Next

The worker fixes findings 1–4 in `README.md` only, then re-review. Leave the task status unchanged (the planner decides).

## Suggested skills

- code-review (docs accuracy against src)
