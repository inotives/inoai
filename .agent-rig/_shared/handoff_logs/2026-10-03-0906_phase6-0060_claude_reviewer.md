---
agent: reviewer
role: reviewer
tool: claude
task: task-0060
task_title: "Phase 6: Review engine and validation"
status: handoff
---

# task-0060 reviewer handoff

**Verdict: changes requested.** I found three Medium and two Low issues. I did not change the task status, edit any implementation, or commit anything. No real CLI was run, and no `.inoai-connect*/.env` was read. My scratch probes ran against `dist/` in the session scratchpad, using a temporary runtime home that I deleted afterwards.

## Findings

### M1. The explicit-signal phrase accepts negated statements and questions

`src/memory-review.ts:31` and `:251-252`. The bare `\bremember\b` in `rememberPhrase` matches text that is not a request to remember anything. A scratch probe, after the worker's stripping, returned true for:

- "I don't remember what the host was"
- "Do you remember our decision?"
- "I can't remember"

The stripping also misses three quote forms:

- single-quoted text, such as `'remember this'`
- double-quoted text that spans lines, such as `"please\nremember…"`
- an unclosed ``` fence

The CONTEXT/proposal rule asks for an explicit *request* to remember. If the model cites one of these Messages for an add, validation passes it today.

**Fix:**

- Reject a match that is directly preceded by a negation or recall verb. One way is a negative lookbehind on `(?:don't|do not|didn't|can't|cannot|couldn't|won't|not|you|we|I)\s+(?:\w+\s+)?`. Another is to require a request form, such as `please remember`, a sentence-initial `remember`, or `can/could you remember`.
- Ignore a match inside a sentence that ends in `?`.
- Strip an unclosed ``` through to the end of the text.
- Strip `'…'` and multi-line `"…"` quotes.

Add regression cases for each form to the "every unverifiable action is ignored" test. Text an owner pastes without quotes ("the doc says remember…") cannot be told apart deterministically and is an acceptable residual. Note it in the code comment.

### M2. A review row's lower bound is not enforced

`src/memory-review.ts:107-114` and `:274`. `selectRange` stops at `review.through_message_id` but reads every Message after the completed cursor, whatever `review.from_message_id` is. Meanwhile `fromId` is taken from the row.

I confirmed this with a scratch run. Messages 1–4 had two pending rows, A (1–2) and B (3–4). Running B first:

- reviewed messages 1–4, and B's prompt included A's text;
- stored B as `from_message_id=3`, `through=4`, `completed`;
- left A permanently `stale_range` and `pending`.

The stored Recap range therefore misstates what was reviewed, and task-0061's scheduling could leave orphan rows behind.

**Fix:** when `review` is given, fail `stale_range` (before any runtime call) if the first selected Message's id differs from `review.from_message_id`. You could instead skip Messages below `from_message_id`, but that risks a gap, so I prefer failing. Add a test with two overlapping or out-of-order rows.

### M3. Line-level redaction leaks values next to a secret label

`src/memory-review.ts:67-69`, plus the shared `secretLike` in `src/prompt-context.ts:9`. Probe results:

| Input | Output | Problem |
| --- | --- | --- |
| `"password:\nhunter2"` | `[redacted]\nhunter2` | The value survives on the next line. |
| `"Authorization: Bearer\nabc.def"` | `abc.def` survives | Same pattern. |
| `"Bearer\nabcdefghijklmnop"` | unredacted | `secretLike` matches across lines, but no single line matches. |
| `{"token":\n "abc123"}` and `"password": "x"` | unredacted | `[\w-]*\s*[:=]` does not allow the closing quote of a JSON key. |
| `-----BEGIN OPENSSH PRIVATE KEY-----` block | unredacted | No pattern covers PEM blocks. |

Inline secrets work: a line holding `sk-…` is replaced whole. Some of these gaps come from the existing filter, but a review persists text into Recaps and Memory, which are re-injected into prompts and shown in the UI.

**Fix:**

1. In `redactSecrets`, when a redacted line ends in a separator or an empty value (`/(?:[:=]|\bis|Bearer)\s*$/i`), also redact the next non-blank line.
2. After line redaction, run `secretLike` on the whole text. If it still matches (a match that spans lines), redact the whole Message.
3. Allow `["']?` before the separator in `secretLike`. This also improves `prompt-context`, so check it with the existing prompt-context tests.
4. Add a PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----` pattern that redacts through the END line.
5. Add tests for the multi-line and JSON-key cases.

### L1. Notices worded for another provider are reviewed as agent text

`src/memory-review.ts:84-93`. `runtimeFailureNotice` and `providerMismatchNotice` are built only for the current `runtime.displayName`. After a provider change, or for a mismatched Session, the archived Codex or OpenCode failure notices are reviewed as agent text. The harm is small: they are agent-authored, so they cannot be an explicit signal, but they add noise and recap content.

**Fix:**

- Build the failure notices from a fixed table covering all three providers:
  - `{Codex, "codex login"}`
  - `{Claude, "claude /login"}`
  - `{OpenCode, "opencode auth login", OpenCode authenticationNotice}`
- Build `providerMismatchNotice(p, name)` for every pair of stored provider and display name.
- Add the startup body `'Legacy approval request redacted'` (`src/database.ts:377`).

### L2. Only the transcript closing tag is escaped

`src/memory-review.ts:133` and `:177-179`. Only the lowercase `</transcript>` is escaped. Model notes, Memory bodies, and Recaps go into `<notes>`, `<memory>`, and `<recaps>` with no escaping, so injected transcript text that the notes echo back could close a section early. Deterministic validation still guards every write (IDs and `origin` are checked against SQLite, not prompt text), so this is defence in depth only.

**Fix:** escape every closing tag, case-insensitively, in each section's content.

## Assessed as correct

- **Validation**
  - An agent message, an agent quoting the owner, or a non-owner user is never an explicit signal; the role comes from SQLite, not from labels.
  - Recurrence requires two or more distinct prior completed Recaps, excluding the current row.
  - Update and delete are allowed only on active `origin='review'` entries; a manual entry gives `manual_entry`.
  - `memory_id` on an add is ignored.
  - Sources must be in range: included entries only.
  - The caps and the secret check on body and recap both apply.
  - The 20-action cap works.
- **The `no_evidence` rule for deletes: keep it.** Deleting on a bare model claim would act on an "unconfirmed model claim", which the proposal forbids, so the rule is conservative. task-0062 should document it in the README or schema notes.
- **Range and cursor**
  - The range stops before `pending` or `processing` Messages.
  - Moving the cursor past trailing notices and failed Messages is correct: they are not reviewable content, and later notices are excluded by text.
  - The 60-window cap ends at a whole Message and shortens `through`, so the tail stays unreviewed for later. Nothing is skipped silently, and the cursor covers exactly what one committed review covered.
  - **For task-0061:** a completed result whose `throughMessageId` falls short of the enqueued range needs a follow-up row.
- **Transaction**
  - It uses `BEGIN IMMEDIATE`, then re-checks the cursor and the row and returns `stale_range` with a rollback.
  - It is all-or-nothing: the injected-trigger test passes, and abort tests write nothing.
  - An update is a soft-delete (with `deleted_by=memory-review`) followed by an insert, so history and audit fields are kept.
  - `created_by_user_id` is null.
  - The Event detail holds only counts and fixed codes.
  - Nothing is logged.
  - **For task-0061:** a `RangeError` from `createMemoryReview` inside the commit is rethrown rather than returned as `failed`.
- **D2**
  - `CodexRuntime.review` exists only when `enableReview` is passed.
  - `createCodexRuntime` and `run()` never pass it.
  - A test asserts `review === undefined`.
  - The exported notice constants produce text byte-identical to `HEAD`. I checked:
    - `permissionDeclinedNotice("Codex")` and the Claude/OpenCode template
    - `legacyApprovalNotice`
    - `fixedTurnNotices` (unchanged constants)
    - `providerMismatchNotice` (only `export` added)
    - `runtimeFailureNotice` (an alias)
- **Prompts:** they are fixed templates, the transcript is tagged as data, there is no tool wording, they ask for JSON only, and the aggregation schema includes `source_recap_ids`.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 170/170 pass, 0 skipped or todo. `HEAD` had 144; task-0059 added 15 (14 runtime-review, 1 approval-relay); task-0060 adds 11. No test was removed or skipped. |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on both new files | No whitespace warnings (exit 1 only because the files differ) |
| `dist/test/memory-review.test.js`, 5 serial reruns | 11/11 each time |

## Next step

A worker reads this handoff together with the worker handoff, fixes M1–M3 (and L1–L2 if cheap) with regression tests, and then the task is re-reviewed.

## Suggested skills

`code-review`, `security-review`
