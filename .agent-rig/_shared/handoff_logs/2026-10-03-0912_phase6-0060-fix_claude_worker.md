---
agent: worker
role: worker
tool: claude
task: task-0060
task_title: "Phase 6: Review engine and validation"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0060 worker fix handoff

**Status:** task set to `review`. I staged and committed nothing, ran no real CLI, and read no `.inoai-connect*/.env`. Chat Turn behaviour and notice texts are unchanged.

Inputs read:
- worker handoff `2026-10-03-0901_phase6-0060_claude_worker.md`
- reviewer handoff `2026-10-03-0906_phase6-0060_claude_reviewer.md` (findings M1–M3, L1–L2)

## Fixes

### M1: explicit-signal rule (`src/memory-review.ts`)

**Code:** `:31-41` (rule comment, `requestForm`, `politeRequest`) and `hasMemorySignal` at `:103-118`, used at `:312`.

**The rule:**
1. Strip quoted text:
   - closed fences, and an unclosed ``` through to the end of the text
   - inline code
   - `>` quote lines
   - `"…"`, `“…”` and `‘…’` quotes, which may span lines
   - `'…'` when the quote is not inside a word, so apostrophes survive
2. Split into sentences on `.`, `!` or `?` followed by whitespace, or on newlines. Remove list markers.
3. A sentence is a signal when, after optional openers (`please`, `also`, `and`, `so`, `ok`, `okay`, `hey`, `oh`, `btw`), it starts with one of these:
   - `remember that`, `remember to`, `remember this`, `remember:`
   - `please remember`, `please note`
   - `note that`, `note this`
   - `take (a) note`, `make a note`
   - `keep (this/that/it) in mind`
   - `don't forget`, `do not forget`
   - `treat this as important`
   - `this is important`, `that is important`, `it is important`
4. A sentence ending in `?` is rejected unless it is a polite `can/could/would/will you (please) remember/note/keep … in mind/take note` request.

Negated or recalled forms are not at sentence start, so they never match. A residual is documented in the code comment: unquoted, pasted text that starts a sentence with a request form still counts.

**Test:** `src/test/memory-review.test.ts:389`. It covers 18 rejected cases (every reviewer probe, plus `didn't`, `couldn't`, `won't`, `not`, `I remember`, `we remember`, questions, single quotes, multi-line double quotes, an unclosed fence, and mid-sentence use) and 9 accepted forms, one review per case.

### M2: lower bound (`src/memory-review.ts:332-334`)

With `reviewId`, if the first selected Message id is not `review.from_message_id`, the review returns `stale_range` before any runtime call.

**Test:** `:434`. Rows A (1–2) and B (3–4):
- Running B first is stale, makes no call, and leaves both rows pending.
- A then completes without B's text.
- B then completes without A's message text.
- Both stored ranges are exact.

### M3: redaction (`src/memory-review.ts:78-97`, `src/prompt-context.ts:9-11`)

- **PEM blocks:** `privateKeyBlock` redacts through the END line, or to the end of the text if the block is cut off.
- **Dangling values:** when a redacted line ends with `:`, `=`, `is` or `Bearer`, the next non-blank line is also redacted.
- **Spanning matches:** after line redaction, if `secretLike` still matches the whole text, the whole Message is redacted.
- **`secretLike` regex:** now allows `["']?` before the separator and matches `-----BEGIN … PRIVATE KEY-----`.

**Tests:**
- `memory-review.test.ts:456`: unit cases for every reviewer probe, a blank-line gap, single-quoted JSON, a truncated PEM, and an unchanged benign case, plus an integration test showing no values reach the prompts.
- `prompt-context.test.ts:107`: Memory with a JSON-key, single-quoted key or PEM secret is excluded, and a benign "token budget" Memory is still injected.
- The existing prompt-context tests still pass unchanged.

### L1: notice table (`src/memory-review.ts:131-154`)

The notice set is built from:
- a fixed `providerNotices` table: Codex/`codex login`, Claude/`claude /login`, and OpenCode/`opencode auth login` with its authentication notice
- the current runtime
- every stored-provider × display-name mismatch notice
- every provider's permission-declined notice
- `legacyApprovalNotice`
- `'Legacy approval request redacted'`

OpenCode's notice text is now exported as `openCodeAuthenticationNotice` (`src/opencode-runtime.ts:30`); its text is unchanged. `runtimeFailureNotice` now accepts a `Pick` of the three fields (`src/runtime-turn.ts:12`); this is a type-only change.

**Test:** `:481`. It builds every notice from real Codex, Claude and OpenCode runtime instances, so any drift in the table fails the test. With all of them archived, the result is `empty` and no call is made.

### L2: tag escaping (`src/memory-review.ts:99-101`, `:194`, `:238-240`)

`escapeTags` breaks up `</transcript>`, `</notes>`, `</memory>` and `</recaps>`, case-insensitively and allowing whitespace inside the tag. It applies to transcript bodies, notes, Memory lines and Recap lines.

**Test:** `:500`. The injection is placed in an owner Message, a Memory body, a prior Recap and echoed notes. The only closing tags left in the prompts are the real ones.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 176/176 pass, 0 skipped. Was 170: +5 memory-review, +1 prompt-context. |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on untracked `src`/`docs` files | No warnings |
| `dist/test/memory-review.test.js` + `dist/test/prompt-context.test.js`, 5 reruns | 19/19 each time |

## Notes for review and task-0061

- The M2 stale check means a scheduled row must start at the first Message after the completed cursor, including failed Messages and notices. Task-0061 should create rows from `cursor + 1` (the first unreviewed Message id).
- Widening `secretLike` (a closing quote, PEM) makes `prompt-context` filter more conservatively. Nothing it filtered before is now let through.

## Suggested skills

`code-review`, `security-review`
