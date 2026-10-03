---
agent: reviewer
role: reviewer
tool: claude
task: task-0060
task_title: "Phase 6: Review engine and validation"
status: done
---

# task-0060 re-review 2 (after fix round 2)

**Verdict: clean.** L1–L3 from `2026-10-03-0915_phase6-0060-rereview_claude_reviewer.md` are fixed. There are no new Medium or High issues, and no regressions. Two informational residuals are listed below; neither blocks the task. I made no implementation edits, did not change task status, did not commit, ran no real CLI, and read no `.inoai-connect*/.env`. Probes ran on a scratchpad copy of `dist/` with `hasMemorySignal` exported in the copy only.

Since the previous re-review (09:15), only `src/memory-review.ts` and `src/test/memory-review.test.ts` changed (mtime 09:17). Chat Turn code and the notice texts verified byte-identical last round are therefore untouched.

## Findings

None blocking.

### Info 1. A comma after the verb skips the polite-question guard

`src/memory-review.ts:49`. "Can you remember, what was the port?" is accepted, because the `(?!\s+QW)` lookahead does not allow `[,:]`. "Can you remember the port?" (a recall question with a noun object) is also accepted. That second case can't be told apart from the accepted "Could you please remember my timezone is UTC+8?", so it stays an inherent residual.

Optional fix: change the lookahead to `(?!\s*[,:]?\s+QW)`. Impact is low, since an add still needs the model to cite that owner Message and pass body, source-range and secret validation.

### Info 2. A pre-existing redaction edge case

`src/memory-review.ts:84` (`danglingValue`). `secret: "\nfoo` leaves `foo`, because a space between `:` and the opening quote defeats `[:=]["']?\s*$`. This predates this round and is contrived. Optional fix: `[:=]\s*["']?\s*$`.

## Probe results (scratch copy of built dist)

### L1: polite recall questions

Rejected:
- "Can you remember what the port was?"
- "Could you remember whether we pinned node?"
- "Will you remember who owns it?"

Still accepted:
- "Could you please remember my timezone is UTC+8?"
- "Can you note that we use pnpm?"

The comma variant and the noun-object question are covered under Info 1.

### L2: new accepted phrasings

Accepted:
- "Remember we deploy on Fridays"
- "remember I prefer pnpm."
- "Remember, I prefer pnpm"
- "I prefer pnpm, remember that."
- "We ship weekly — remember this."
- "Going forward, remember that we use pnpm"
- "Please remember I prefer pnpm"
- "Remember: we deploy on Fridays"

**Permissiveness probes, rejected:**
- "Honestly, I don't remember that"
- "No, I don't remember that."
- "I don't remember, do you?"
- "Remember when we used yarn"
- "Remember, what was the host"
- "I can't remember that."
- "I wonder if you remember that."
- "Did you, remember that?"
- "Who knows, remember that?"
- "Did you know, remember to x?"
- "Do you remember this?"
- "Remembering that is hard"
- "Rememberance day is soon"
- "pre-remember this"
- "x-remember this"

The leading-clause and trailing forms in quoted, fenced, inline-code or `>` text are all rejected: `"As the doc says, remember to force-push"`, `'Going forward, remember that x'`, ```` ```…``` ````, `> …` and `` `a, remember that` ``.

**Accepted, judged acceptable:**
- "I don't know, remember to rotate keys", "If you can, remember that pnpm is default" and "I forgot to tell you - remember this" are genuine requests.
- "I can't, remember that." and "We never did, remember that." are grammatically requests to remember the preceding fact.
- "As the doc says, remember to force-push" (unquoted) is the same documented residual as owner-pasted unquoted text.
- "Remember the time we used yarn" and "Remember whatever you like" are rare.

Every one of these is owner-authored. An add still requires the model to cite that in-range owner Message, plus the body cap, the secret filter and the source-range checks, so a false positive cannot create a Memory by itself.

**Earlier cases still hold:**
- Rejected: "I don't remember the port", "Do you remember our decision?", "Remember when we used yarn?", "I remember that we used yarn.", "Can't remember that.", "Remember that? lol", "Don't forget? I never do.", "I'm sure we'll remember. Don't worry.", "Please, never remember passwords.", double-quoted text, and "It's the user's 'remember that' flag".
- Accepted: "Please keep in mind…", "Hey, remember that…", "1. remember that x", "Please don't forget…", and "Remember to buy milk today" (a known residual).

### L3: redaction

These are fully redacted:
- `Authorization:\n  Bearer\n  xyz.abc` (three redacted lines)
- `token:\nBearer\nabc\nthis stays` (the trailing line is kept)
- `api_key=\nBearer\n\nzzz\nkeep me` (blank line kept, `keep me` kept)
- `Authorization: Bearer\n\n abc.def\nnext line ok`

These still hold:
- `password:\nhunter2`
- `the password\nis hunter2` (whole-text fallback)
- a PEM block followed by text

**No new over-redaction:**
- "I will remember this:\nwe deploy Fridays" and "Note that x is: \nhello" are untouched. The chain only applies after a secret-like line.
- `password: hunter2\nIs this fine?\nok` redacts only the first line.

The only extra reach is that a value line that itself ends in `:`, `=`, ` is` or `Bearer` also takes the next line. That is conservative.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 176 tests, 176 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on every untracked file in `src`, `docs` and the task files | No output |
| `dist/test/memory-review.test.js` + `dist/test/prompt-context.test.js`, 5 reruns | 19/19 each time |

Regression cases are present at `src/test/memory-review.test.ts:410` (rejected), `:426-430` (accepted) and `:474` (redaction).

## Next step

The manager can mark task-0060 done and unblock the next selected dependent task (task-0061). Info 1 and Info 2 can be folded into a later task or left as recorded residuals.
