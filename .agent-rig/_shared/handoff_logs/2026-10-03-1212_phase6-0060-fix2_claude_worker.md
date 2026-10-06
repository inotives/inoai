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

# task-0060 fix round 2: re-review L1–L3

This round fixes the three Low findings from `2026-10-03-0915_phase6-0060-rereview_claude_reviewer.md`. It touches only `src/memory-review.ts`, `src/test/memory-review.test.ts` and the task Notes. I did not commit or stage anything, ran no real CLI, and read no `.inoai-connect*/.env`.

## Changes

### `src/memory-review.ts`

- **`:40` `questionWord`:** a new shared fragment matching what, when, where, which, who, whom, whose, why, how, if and whether.
- **`:44-48` `requestForm` (L2):** now three alternatives.
  1. After the opener, the `remember` branch accepts `remember` followed by an optional `,` or `:`, whitespace, and a word that is not a question word. The bare `remember:` is still accepted. The other request forms are unchanged.
  2. A sentence-start leading clause of 1–40 characters, with no `, . ! ? ; :`, ending in a comma, then `remember that` or `remember to`.
  3. A sentence ending in `, remember that/this` or a dash (`-`, `–` or `—`) followed by `remember that/this`, with optional `.` or `!`.

  A sentence ending in `?` is still rejected before `requestForm` runs.
- **`:49` `politeRequest` (L1):** a `(?!\s+questionWord)` lookahead after the verb.
- **`:95-97` `redactSecrets` (L3):** a consumed owed-value line sets `owesValue = danglingValue.test(line)`, so a chained dangling line still owes the next line.

### `src/test/memory-review.test.ts`

**Rejected signal cases (from `:410`):**
- "Can you remember what the port was?"
- "Could you remember whether we pinned node?"
- "Remember when we used yarn"
- "Remember, what was the host"
- "I can't remember that."

**Accepted signal cases (from `:426`):**
- "Remember we deploy on Fridays"
- "Remember, I prefer pnpm"
- "I prefer pnpm, remember that."
- "We ship weekly — remember this."
- "Going forward, remember that we use pnpm"

**Redaction (`:474`):** `"Authorization:\n  Bearer\n  xyz.abc"` becomes three redacted lines, so `xyz.abc` is gone.

All earlier rejected cases still hold.

## Extra probes on built `dist`, not added as tests

**Rejected:**
- "Remember that? lol"
- "Please, never remember passwords."
- "Remember when we used yarn?"
- "I remember that we used yarn."
- "Can't remember that."
- "Don't you remember the port?"
- "Will you remember who owns it?"
- "Honestly, I don't remember that"
- "Rememberance day is soon"

**Accepted:**
- "remember I prefer pnpm."
- "Going forward, remember that I prefer pnpm."
- "Remember: we deploy on Fridays"
- "Could you please remember my timezone is UTC+8?"
- "Remember to buy milk today", which is a known residual and was already accepted.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 176/176 pass, 0 fail. New cases were added inside existing tests, so the count is unchanged. |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on untracked `src/memory-review.ts` and `src/test/memory-review.test.ts` | No output |
| `dist/test/memory-review.test.js`, 4 reruns | 16/16 each time |

## Residuals

The leading-clause and trailing forms are slightly more permissive. "I don't know, remember to…" counts, for example. Any add is still accepted only when the model cites that owner Message, and the failure direction is limited to an owner-authored sentence.

## Next step

A reviewer re-checks L1–L3.
