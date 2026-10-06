---
agent: reviewer
role: reviewer
tool: claude
task: task-0065
task_title: "Phase 6: Engine-detected explicit memory requests for aggregation"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Reviewer handoff: task-0065

Verdict: **clean, no blocking findings.** I made no implementation edits and did not change the task status. Nothing was committed, no real CLI was run, and no `.inoai-connect*/.env` was read.

Inputs: `AGENTS.md`, `.agent-rig/reviewer/instructions.md`, the task file, the task-0063 live handoff (`2026-10-03-1245_phase6-0063_claude_worker.md`), the worker handoff (`2026-10-03-1300_phase6-0065_claude_worker.md`), ADR 0010, `src/memory-review.ts`, and `src/test/memory-review.test.ts`.

## What I verified

- **Selection matches the validator.** `explicitRequests(included)` (`src/memory-review.ts:264-269`) filters `included` on `role === "owner" && hasMemorySignal(entry.body)`. `commit` builds the validator's `entries` map from the same `included` array (`:406`), and `validateAction` runs the same `hasMemorySignal` on the same `entry.body` (`:335`), which is the redacted body from `selectRange` (`:190`). Owner filtering is the same in both places because non-owner user Messages never become entries. The section can be shorter than the accept set because of the budget, but it never lists something the validator would reject.
- **Redaction and escaping.** Bodies are already redacted by `redactSecrets`. Each line goes through `escapeTags`, and `explicit_requests` is in `closingTag` (`:112`), so text in any section, the transcript included, cannot close it. Whitespace is collapsed after escaping. The escaped form `</ x>` contains no whitespace, so collapsing cannot turn it back into a real closing tag. Truncation only takes a prefix, so it cannot create a tag either.
- **Budgets.** Each line is at most 500 characters, ending in `…` when cut. The section uses `withinBudget(…, 4000)`, which counts the newline separators. Lines stay in chronological order.
- **Template** (`:249-258`):
  - The data-only line now names `<explicit_requests>`.
  - The new rule tells the model to "consider" each entry for add or update and to cite its ID. It keeps "skip any that is a secret, a one-off task, or not a durable fact", so it does not weaken the existing secrets/one-off guidance.
  - The JSON-only reply line and the add/update/delete rules are unchanged.
  - There is no tool wording.
- **Unchanged.** `validateAction` and `commit` are untouched. The window prompt and the fixed system prompt are unchanged. The new identifiers appear only in `memory-review.ts` (grep), so chat Turns are unaffected. Nothing new is logged or stored.
- **Tests are meaningful.**
  - Test 1 recreates the live failure: the notes keep the fact but drop the request. It asserts that the aggregation prompt carries `[message N] Please remember that I prefer pnpm…` together with the rule text, and that an `add` citing N is applied with `source_message_id = N`. A model that reads only the section now has both the ID and the instruction to consider it. Fake runtimes cannot prove that a live model will act on it, which is why task-0063 still needs its re-run.
  - Test 2 shows that quoted and `>` text, an agent "Remember:", "I don't remember", a "Remember that…?" question, and "Do you remember" are excluded. It shows the secret is redacted in place and that `sk-test` and `api_key` appear in no prompt. It also checks `(none)`.
  - Test 3 covers the per-line cut and the total budget.
  - The injection test now covers `</explicit_requests>` and the section order.

## Findings (all non-blocking)

1. **Low (handoff wording only):** `2026-10-03-1300_phase6-0065_claude_worker.md`, the new-tests item 3 says requests dropped by the budget "wait for the next run". That is not true. `throughId` still covers those Messages and the cursor moves past them, so a later review never lists them again. They can still become Memory in this run only if the notes cite them. The test comment at `src/test/memory-review.test.ts:~590` ("the newest wait out the budget") is only ambiguous. Fix: correct the wording if this note is reused. No code change is needed for this task.
2. **Info:** `withinBudget` skips a line that does not fit and keeps going, so a later, shorter line can still be listed after a longer one is dropped. The list is chronological but not always a strict prefix. This has no practical effect because every line is at most 500 characters.
3. **Info / test gap:** no test shows that owner requests beyond the `maxWindows` cap are left out of the section. The code is correct by construction, since it uses `included`.

## Which requests to drop on overflow (recommendation)

Dropping the newest is acceptable for V1. With a 4000-character budget, overflow needs at least 8 maximum-length requests, or dozens of short ones, in a single review range, which is rare.

If anything changes, keeping the newest is the better trade. A later request often corrects an earlier one ("actually, remember yarn"), and an `update` needs the newest wording.

The most faithful fix would be a follow-up: end the review range before the first request that did not fit, the same way the window cap ends a range. Every request would then be listed in some review and none would be silently skipped. This is not required for task-0065.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 190 tests, 190 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo (187 → 190; no `.skip`, `.only`, or `todo` in `src/test`) |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `git diff --check` | clean |
| `git diff --no-index --check /dev/null` on `src/memory-review.ts`, `src/test/memory-review.test.ts` | no output |
| `node --test dist/test/memory-review.test.js` ×3 | 19/19 pass each time |

## Next step

The planner can mark task-0065 `done` and then re-run task-0063's live seeded Claude review, as the task's Planner Notes say.

## Suggested skills

- code-review
