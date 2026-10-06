---
agent: reviewer
role: reviewer
tool: claude
task: task-0060
task_title: "Phase 6: Review engine and validation"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0060 re-review (after fix round)

**Verdict: not clean, but only three Low findings remain.** M1–M3 and L1–L2 from the first review are fixed. There is no Medium or High issue. Each remaining finding is a one-line regex or state change plus a test case. I recommend one short fix round, or the manager can accept these as recorded residuals. I made no implementation edits, did not change task status, did not commit, ran no real CLI, and read no `.inoai-connect*/.env`. Probes ran against `dist/` from the session scratchpad, using a temporary runtime home that I deleted afterwards.

## Findings

### L1. A polite recall question counts as an explicit signal

`src/memory-review.ts:41` (`politeRequest`), used at `:115`.

"Can you remember what the port was?" is accepted, because `politeRequest` matches any `can/could/would/will you remember…`, including a question that asks for recall. This is the same class as the original M1 ("Do you remember our decision?"), only narrower. The add is still accepted only if the model cites this Message.

**Fix:** after the verb, reject when the next word is a wh-word, `if` or `whether`. Example: `(?!\s+(?:what|when|where|which|who|why|how|if|whether)\b)`. Add a rejected case to the test at `src/test/memory-review.test.ts:389`.

### L2. Natural imperative phrasings are missed

`src/memory-review.ts:40` (`requestForm`).

These are rejected as `no_memory_signal`:
- "Remember we deploy on Fridays" (no `that` or colon)
- "remember I prefer pnpm."
- "Remember, I prefer pnpm"
- "I prefer pnpm, remember that."
- "Going forward, remember that I prefer pnpm."

The two phrasings the planner named both pass: "Please remember I prefer pnpm" and "Remember: we deploy on Fridays". The failure is in the safe direction, since the action is dropped and nothing wrong is written. Still, a bare imperative "Remember <clause>" is the most natural owner form.

**Fix:**
- Accept a sentence-initial `remember,?\s+` unless the next word is `when`, `what`, `how`, `where`, `who`, `why`, `if` or `whether`. Questions are already rejected by the `?` rule.
- Optionally, accept a trailing `, remember that.` or `remember this.` clause.
- Add accepted cases to the test.

### L3. A chained dangling separator leaks its value

`src/memory-review.ts:86-90` (`redactSecrets`).

`"Authorization:\n  Bearer\n  xyz.abc"` becomes `[r]\n[r]\n  xyz.abc`. When the owed line ("Bearer") is consumed, `owesValue` is reset without re-checking whether that line itself dangles. The whole-text `secretLike` fallback does not catch it either, because the token on its own line matches no pattern. The input is contrived but plausible from a copy-paste.

**Fix:** in the `owesValue` branch, set `owesValue = danglingValue.test(line)` instead of `false`. Add this input to the redaction test at `src/test/memory-review.test.ts:456`.

## Probe results (built `dist`)

### M1: explicit signal

All 18 rejected cases in the test hold. My extra probes:

**Correctly rejected:**
- "I don't remember…", "Don't you remember the port?", "Do you remember our decision?", "Remember when we used yarn?"
- "I remember that we used yarn."
- "Can't remember that."
- "Remember that? lol"
- "Don't forget? I never do."
- "I'm sure we'll remember. Don't worry."
- "Please, never remember passwords."
- quoted forms: `'…'`, `"…"` and `‘…’`
- a `>` quote line, inline code, and a closed or unclosed ``` fence
- "It's the user's 'remember that' flag" (apostrophes survive, and the quoted span is still stripped)

**Correctly accepted:**
- "Please remember I prefer pnpm"
- "Remember: we deploy on Fridays"
- "Please keep in mind…"
- "Could you please remember my timezone is UTC+8?"
- "Can you note that…?"
- "Hey, remember that…"
- the list markers `1.` and `*`
- "Please don't forget…"

**Wrong:**
- False positive: "Can you remember what the port was?" (L1).
- False negatives: listed under L2. "Note: …", "Important: …" and "It's important that…" are also not accepted. That is acceptable.

**Acceptable residuals:**
- "Please remember nothing from this chat." is accepted. It is a negated object and an edge case.
- "Remember to buy milk today" is accepted as a signal. The prompt tells the model to leave out one-off tasks.

### M2: out-of-order rows

The test at `:434` covers this: B before A is `stale_range` with zero runtime calls, then A and then B complete with exact stored ranges and no cross-contamination. The check at `src/memory-review.ts:334` runs before any `ask`.

### M3: redaction

These are all fully redacted:
- `password:\nhunter2`
- `password =` with three newlines before `hunter2` (blank lines skipped)
- a multi-line JSON `"token":` with its value on the next line
- `{"access_token":"abc123"}`
- `{'secret' : 'x'}`
- `Bearer\nabcdefghijk` (whole-message fallback)
- `token\n:\nabc` (whole-message fallback)
- PEM `PRIVATE KEY` and `ENCRYPTED PRIVATE KEY` blocks, with following text kept
- a truncated PEM block
- `my password is hunter2`, `sk-…`, `ghp_…`, a JWT, `PASSWORD=`, `export GITHUB_TOKEN=`, `AWS_SECRET_ACCESS_KEY =`
- `the password\nis hunter2`

Leaks:
- `Authorization:\n  Bearer\n  xyz.abc` (L3).
- `key:\nhunter2` survives, because bare "key" was never a label in the filter, before or after this change. That is out of scope.

**Shared `secretLike` over-redaction in prompt-context:** "token budget", "secret sauce recipe" and "API key rotation policy" are not matched. I compared the old and new regexes. The only newly matched texts are a quoted label followed by a separator (`{"max_tokens": 4096}`, `"tokenizer": "cl100k"`, `the 'secret' is: patience`, `He said "token" is overloaded`) and PEM BEGIN lines. Matches that already existed ("Our secret is good docs.", "Authorization is handled by the gateway", "Bearer tokens expire hourly", "max_tokens: 4096") are unchanged. **Judgement: acceptable.** The direction is conservative: a Memory or reply quote is left out of the prompt, nothing is exposed, and nothing filtered before is now let through.

### L1 (prior): notice table

Every notice-producing site in `src/` is covered:
- `conversation-worker.ts:68`, `:153`, `:176`, `:184` and `:194` produce `failureNotice`, `uncertainNotice`, `providerMismatchNotice` and the runtime failure notices.
- `approval-relay.ts:48` (Codex) and `:68` (Claude and OpenCode `permissionDeclinedNotice`).
- `index.ts:243` (`legacyApprovalNotice`).
- `database.ts:377` (`Legacy approval request redacted`).
- `archiveResponseChunks` carries real answers, not notices.

The `kinds` list matches `RuntimeFailureKind` (`agent-runtime.ts:37`), and the table's display names and login hints match all three runtimes. The `:481` test builds the notices from real runtime instances, so drift is caught.

### L2 (prior): tag escaping

Every closing tag (case-insensitive, whitespace allowed) is escaped in transcript bodies, notes, Memory lines and Recap lines. The test at `:500` asserts only the real closing tags remain.

### Notice texts and chat Turns

Notice texts are byte-identical to `git show HEAD:`:
- the Codex `permissionDeclinedNotice` and the Claude/OpenCode template
- `legacyApprovalNotice`
- the OpenCode authentication notice (now `openCodeAuthenticationNotice`)
- `providerMismatchNotice` (only `export` added)
- `runtimeFailureNotice` (an alias; its parameter type was narrowed to a `Pick`, type-only)

Chat Turn code paths are unchanged apart from the stricter shared `secretLike`, judged acceptable above.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 176/176 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled. 170 → 176; the test diff only adds lines. |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on untracked `src`, `docs` and task files | No whitespace output |
| `dist/test/memory-review.test.js` + `dist/test/prompt-context.test.js`, 5 reruns | 19/19 each time |

## Next step

A worker fixes L1–L3 with the regression cases above, then a quick re-review follows. Or the manager accepts them as documented residuals and marks the task done.

## Suggested skills

`code-review`, `security-review`
