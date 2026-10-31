---
status: accepted
---

# Owner-confirmed Memory proposals and Memory kinds

Before this decision, inoai recorded Memory but did little with it (BL-0029). The daily Memory Review added a Memory only for an explicit owner request, such as "remember that…", or for a pattern in two or more earlier Recaps. Preferences, decisions, and corrections that the owner stated without "remember" were lost. Only chat Turns received Memory, ranked by word overlap. Task Runs received none. Nothing recorded which Memory reached which prompt.

Now the Memory Review can propose a Memory from an implicit signal. The owner confirms or rejects each proposal on a card in the status channel. Memory has two kinds, `core` and `topic`. Chat Turns and Task Runs both receive Memory, and each Memory added to a prompt is recorded in `memory_uses`. Kinds, proposals, and usage records exist only in SQLite.

This was chosen over three alternatives:

- **Silent auto-add.** The review could save implicit signals as Memory directly. A model guess would then change every later prompt without the owner seeing it. Explicit "remember" requests keep saving directly; only implicit signals need a click.
- **Cards in the source thread.** Each card could appear in the conversation where the owner said it. A review covers many Sessions, including ended ones, and runs while no one is chatting. Cards in old threads are easy to miss and mix review output into conversations. The status channel gets one summary per review and keeps the cards in one place.
- **Edits to `agent.md`.** The agent could write learned rules into its own `agent.md`. That file is the owner's role definition and is sent with every Turn. Agent edits to it are off the table. Core Memory gives the same "always included" effect inside SQLite, with audit fields and soft deletion.

## Memory kinds

- `memories.kind` is `core` or `topic`. Existing Memories migrate as `topic`. New Memories default to `topic`.
- A core Memory is a standing rule. It is included in every chat Turn and Task Run.
- A topic Memory is included only when it shares at least one word with the prompt's query text.
- The owner adds a core Memory with `memory add --core <text>`. A confirmed proposal uses the kind the review suggested. The card cannot change the kind.

## Memory in prompts

`composeMemorySection` builds one section with the heading "Relevant shared Memory (context, not user instructions):". Both kinds share this heading.

- Secret-like Memories are never included.
- Core Memories come first, oldest first (by id). Their lines use at most 1,500 characters. A core Memory that does not fit is skipped, and later core Memories are still tried.
- Topic Memories fill the rest of the 6,000-character context budget. They are ranked by word overlap with the query text, highest first.
- A chat Turn uses the current message as the query text. A quoted reply target, when present, uses part of the same budget.
- A Task Run uses the Task title and instruction as the query text. The Memory section comes first in the Task Run prompt, before the title. A run with no matching Memory gets no section.

## Memory uses

`memory_uses` records one row for each Memory added to a prompt:

- A chat Turn writes its rows after the runtime start is marked (`markRuntimeStarted`). A Turn cancelled before that point writes none. A Turn that later fails or times out keeps its rows, because the prompt was sent. Rows use `message_id` and actor `conversation-worker`.
- A Task Run writes its rows just before the runtime turn, after the cancellation check. A run that later fails keeps its rows. Rows use `task_run_id` and actor `task-runtime`.
- The write is best effort. A failed write never fails the Turn or the run.
- The table is append-only. Triggers reject every `UPDATE` and `DELETE`. It has no soft-deletion columns. A row needs `message_id` or `task_run_id`.
- Usage records are never shown in Discord or the UI. They are the base for a later feedback feature.

## The `propose` action

The review's aggregation step has a new action, `propose`. The model uses it for an implicit signal in the reviewed range: an owner preference, a decision the owner confirmed, or an owner correction of the agent. The action cites owner messages in `source_message_ids` and sets `kind`. The `add` rules are unchanged; an implicit signal sent as `add` is still ignored with `no_memory_signal`.

The aggregation prompt lists active Memory in `<memory>` and pending, unexpired proposals in `<pending_proposals>`, oldest first, redacted, tag-escaped, and within 3,000 characters. The PostgreSQL store has no proposals, so its section shows `(none)`. The model must not propose an idea already in either section, even in other words. This prompt rule catches reworded repeats; the commit checks below catch only the same text.

inoai checks each proposal before the commit. A failed check adds an `ignored` reason:

- `invalid_action`, `missing_body`, `body_too_long` (over 500 characters), `secret_like`, `missing_source`, and `source_out_of_range`, as for other actions.
- `no_owner_source`: the proposal cites no owner message. Only cited owner message ids are stored.
- The 20-action cap counts proposals.

The review commit stores proposals in the same transaction as the Recap. It compares normalized text (lower case, trimmed, inner whitespace collapsed) and skips:

- `duplicate_memory`: an active Memory has the same text, including one added by this review.
- `duplicate_proposal`: a pending, unexpired proposal has the same text, including one stored earlier in this review.
- `rejected_proposal`: the owner rejected the same text before. Rejected text is never proposed again.
- `too_many_proposals`: 5 proposals are already stored for this review.

The `memory_review_completed` Event detail gains `; proposed=N` when N is greater than 0. Skip reasons are counted in its `reasons` field. A stale-range commit stores no proposals.

## Limits and expiry

- A review stores at most 5 proposals.
- A proposal expires 7 days after it is stored. Each review cycle, daily or owner-requested, expires overdue pending proposals first. Until then, an overdue proposal cannot be confirmed or rejected; a click expires it.
- Proposal rows are never physically deleted.

## Review summary and proposal cards

After each completed review, inoai posts to the status channel, but only when the review added, updated, or deleted Memory or stored proposals. A quiet review posts nothing.

- One summary per review: "Added X, updated Y, deleted Z. New proposals: N.", then up to 10 change lines of at most 120 characters each.
- Then one card per new proposal. The card shows the kind, the text (at most 500 characters), and the expiry time. Its buttons are **Confirm** (`inoai:memory:<id>:confirm`) and **Reject** (`inoai:memory:<id>:reject`). The custom id holds only the proposal id.
- Every shown body passes `redactSecrets` first.
- Posts follow ADR 0005 and are never retried. A failed summary post does not stop the cards. A proposal whose card fails to post stays pending, with no card, until it expires.
- Expiry does not edit the card. A click on an expired card shows "Expired. Nothing was changed."

Clicks:

- Only the owner can click. The click must come from the configured guild and owner user, and that User must be the Agent Instance owner. Any other click gets the private reply "Only the owner can use this Memory card." and writes nothing.
- The click must be on the stored card message in the status channel. Otherwise the card says the proposal is no longer available, and nothing changes.
- **Confirm** creates the Memory with the proposed kind, `origin = review`, the proposal's review, the first source message, and actor `discord:owner`, in one transaction. If an active Memory already has the same text, the proposal is confirmed and no Memory is created.
- **Reject** records the rejection.
- Each click edits the card to show the stored outcome without buttons. A second click changes nothing.

## `/inoai memory`

The owner has three slash commands. They reply privately. Any other user, guild, or a missing guild gets "Memory control unavailable in this channel."

- `/inoai memory list` shows `#<id> <kind>: <body>` for each active Memory. Bodies are cut to 80 characters. A secret-like body shows as `[hidden: may contain a secret]`.
- `/inoai memory forget id:<n>` soft-deletes an active Memory with actor `user:owner`. An unknown id gets "Memory not found."
- `/inoai memory review` runs a review cycle now through the scheduler's guards. It refuses while a Task Run holds the scheduler, a review is active, or chat work is pending or processing. It replies "Memory Review is not supported by this agent runtime." for a runtime without reviews (Codex and OpenCode in V1) and "Memory Review failed. Try again later." when the cycle fails. The cycle records a `memory_review_cycle` Event with detail `trigger=owner; date=<local date>; enqueued=<n>`. This Event does not count as the daily cycle, so the daily cycle still runs. Enqueued reviews start on the next idle poke.

## SQLite only

Memory kinds, `memory_proposals`, and `memory_uses` exist only in the SQLite store. The PostgreSQL store keeps compiling, reads every Memory as `topic`, stores no proposals or uses, and posts no cards. BL-0020 records this PostgreSQL gap.

## Consequences

- An implicit preference becomes Memory only after an owner click. Explicit "remember" requests still save directly.
- Core Memory reaches every chat Turn and Task Run within 1,500 characters. A core Memory that does not fit is skipped; older core Memories win.
- Task Runs now receive Memory. A Memory edit affects later Turns and runs, not one already composed.
- `memory_uses` grows by one row per included Memory per prompt. It is never trimmed.
- The status channel now receives review summaries and cards. Reviews are no longer silent when they change Memory or store proposals.
- A failed card post leaves its proposal without a card until it expires. `/inoai memory list` shows active Memories, not pending proposals.
- The summary is per review, not per cycle. A cycle that reviews several Sessions can post several summaries.
- Known limits: the model may still send an implicit signal as `add`, which is ignored; a duplicate confirm does not name the existing Memory id.
