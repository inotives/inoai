---
status: accepted
---

# The agent proposes Tasks in chat, and only an owner click saves them

The owner can ask for a Task in an ordinary Discord conversation, for example "every weekday at 9, check the failing CI jobs and give me a short summary" or "pause the CI summary". Each owner turn in a normal conversation carries a short per-turn instruction. When the owner asks for scheduled, repeated, or later work, or asks to edit, run, pause, resume, or cancel a Task, the agent ends its reply with one fenced `inoai-task` block that holds JSON. inoai removes the block, validates it, and stores a proposal in the `task_proposals` table. It then posts a confirm card with buttons. Nothing changes until the owner clicks the card's Create or Confirm button. `/inoai task …` stays as a fallback.

This was chosen over three alternatives:

- **Keyword detection plus a separate extraction call.** Keywords miss ordinary wording and match unrelated text. A second model call adds cost, latency, and a second prompt that can disagree with the conversation. The agent already understands the request in context.
- **A `draft` Task state.** It needs a `tasks` table rebuild and a filter in the scheduler, the UI, and inbound checks. A separate table needs only `CREATE TABLE IF NOT EXISTS` and keeps unconfirmed work out of every Task read.
- **Discord modals or an Edit button on the card.** A modal duplicates the UI form inside Discord and needs its own validation path. The owner changes a proposal by replying in chat; the agent then posts a revised card that replaces the old one.

## Who can propose

- Only owner turns get the instruction. A turn is an owner turn when its Message's User is the configured owner.
- Only normal conversations (threads started by a mention, ADR 0006) get the instruction. A Task Session, where `agent_session_id` starts with `pending:task:` or a Task uses the Session, does not. Owner messages in Task threads stay steering notes, and Task Runs never pass through the chat worker.
- A block from any other turn is removed and dropped. It creates no proposal and no note.
- The instruction lists up to 20 active and paused Tasks as `#<id> <title>: <schedule label>`, plus the current local time and the default time zone. If the Task list cannot be read, the turn runs without the instruction.

## Block format

The block is a fenced code block:

- The opening fence is 3 or more backticks or tildes at the start of a line. Indentation, `>` quote markers, and list markers (`-`, `*`, `+`, `1.`, `1)`) may come before it.
- `inoai-task` may appear anywhere in the info string, in any letter case, as a whole word (no letter, digit, `_`, or `-` next to it).
- The closing fence uses the same character and is at least as long as the opening fence. JSON may also start on the opening line after the tag and close on that line.
- A block with no closing fence runs to the end of the answer and is invalid.

The JSON shapes:

- Create: `{"action":"create","title":…,"instruction":…,"expectedOutput":… or null,"schedule":{…},"timezone":"<IANA name>","endsAt":<unix seconds> or null,"maxRuns":<number> or null}`.
- Edit: `{"action":"edit","task":<id>, …every create field}`.
- Management: `{"action":"run"|"pause"|"resume"|"cancel","task":<id>}`.
- Schedule kinds are the IP-0002 kinds: `once`, `interval`, `daily`, `days`, `weekly` (see `docs/sqlite-schema.md`, Task schedules).

Parsing rules:

- inoai removes every `inoai-task` block from the answer and uses only the last one. Other code blocks stay. An answer without a block is unchanged.
- Safety net: a line where ```` ``` ```` or `~~~` comes before an `inoai-task` tag, for example a fence in the middle of a line, is a block the reader missed. inoai cuts the answer from the start of that line to the end and treats the block as invalid. This can drop prose earlier on that line. Raw JSON never leaks.
- A block shown as an example inside another code block is read as a real block and becomes a real proposal. The agent is told not to show the JSON.

Validation:

- Create and edit use `validateTaskSpec`. A missing, null, or blank `timezone` uses `OWNER_TIMEZONE`, or the host time zone when it is unset.
- Edit and management need a positive integer `task` that names an existing Task.
- An invalid block creates no proposal. inoai adds one note after the reply, `Task card not created: <reason>`. The note names fields but holds no block content. A reply that held only an invalid block posts only the note.
- A reply that held only a valid block posts no answer text. The turn still completes; it does not fail with `empty_answer`.

The raw block never reaches Discord or the archive. Memory Review reads the archive, so it never sees the JSON either.

## Confirm card

- inoai posts the card in the conversation thread after the turn's answer chunks. Card sends follow ADR 0005: a failed send is never retried, and the proposal becomes `failed`.
- A create or edit card shows the title, instruction (500 characters), expected output (300 characters), schedule label, next 3 runs, time zone, report destination, and expiry time. Long text is cut on the card; the full text stays in `spec_json`.
- A management card shows the action (Run task now, Pause task, Resume task, Cancel task) and the Task id and title.
- Buttons: **Create** and **Cancel** for a create card; **Confirm** and **Cancel** for the others. Custom ids are `inoai:proposal:<id>:create` and `inoai:proposal:<id>:cancel`. They hold only the proposal id. The handler reads the proposal from SQLite, so a card works after a restart until it expires.
- The first Create or Confirm click claims the proposal (`pending` to `confirming`) and changes the card to "Creating…", "Saving…", or "Working…" within Discord's 3-second window. After the action, the proposal becomes `confirmed` or `failed`, and the card shows the result with no buttons.
- A click while the proposal is `confirming` gets the private reply "This card is already being confirmed." A click on a resolved card answers with its state and removes the buttons. Create is idempotent: a second click creates nothing.
- Cancel resolves the proposal as `cancelled` and changes nothing else.

The card is the only way a chat-proposed Task is saved or changed.

## Actions on confirm

inoai checks the spec and the Task state again on confirm. Proposal writes and Task create, edit, pause, and resume use actor `discord:owner`. Run now and cancel use the Task runner's own actors, as `/inoai task run` and `/inoai task cancel` do.

- **Create without `DISCORD_TASK_CHANNEL_ID`:** inoai posts a starter message in the conversation's parent channel, opens a thread named after the title (100 characters), creates a Session (`pending:task:<thread id>`), and creates the Task. Reports go to that thread. The card links to it. If a step fails, inoai removes what it created when it can.
- **Create with `DISCORD_TASK_CHANNEL_ID`:** inoai creates a `pending:ui:` placeholder Session and the Task, as the UI does (ADR 0026). The first run opens the thread in the task channel.
- **Edit:** the IP-0002 edit rules. Only an active or paused Task with no run in progress. The next run is recalculated from now.
- **Run now and cancel:** the Task runner, as `/inoai task run` and `/inoai task cancel` do. Cancel ends the Task and stops a run in progress.
- **Pause and resume:** the existing store rules.

## Proposals

`task_proposals` holds each proposal until it is resolved. Columns, CHECK rules, and events are in `docs/sqlite-schema.md`.

States:

- `pending`: the card waits for a click.
- `confirming`: a click claimed the proposal and the action is running.
- `confirmed`: the action succeeded. A create stores the new Task in `result_task_id`.
- `cancelled`: the owner clicked Cancel.
- `expired`: the proposal timed out, was replaced, or its Session ended.
- `failed`: the card could not be sent, the action failed, or inoai stopped during `confirming`.

A conversation has at most one pending proposal. A proposal expires:

- **after 24 hours.** A sweep runs every 60 seconds, at startup, after `/inoai reset`, and after each new card. It also removes the buttons of resolved cards.
- **on replacement.** A new proposal in the same conversation expires the earlier pending one in the same transaction. Its card says "Replaced by a newer card."
- **on reset.** `resetSession` expires the Session's pending proposals in its own transaction (ADR 0004). Every claim also checks that the proposal's Session is still active; otherwise the proposal expires.
- **at startup.** Overdue pending proposals expire, and proposals left in `confirming` become `failed`.

## Owner-only clicks

A click counts only when it comes from the configured guild and the configured owner's Discord user, and that User's internal id is the Agent Instance owner. Any other click gets the private reply "Only the owner can use this task card." and writes nothing. Allowlisted family users can chat, but they cannot propose or confirm Tasks.

## Consequences

- No Task is saved or changed without an owner click.
- The `tasks` table, scheduler, and executor are unchanged. Confirmed Tasks run on the IP-0002 scheduler.
- `archiveResponseChunks` accepts an empty list, so a block-only reply completes its turn with no answer text.
- Each proposal and its outcome are recorded as Events with ids, kinds, and reason codes only.
- Known limits, listed in BL-0016 and BL-0017:
  - a card waiting for the answer chunks is lost on restart; its proposal stays pending until it expires or is replaced;
  - a crash during Create can leave a thread without a Task; the proposal ends `failed`;
  - if `finishTaskProposal` throws after a successful Create, the click fallback says "Please try again"; the proposal stays `confirming`, with the card on "Creating…", until restart;
  - a busy SQLite lock can make a click miss Discord's 3-second window;
  - a failed card edit is not retried; `card_closed_at` is set even when the edit failed, so a later click on a replaced card may say "Expired" instead of "Replaced";
  - a very long fence line followed by a bare carriage return parses slowly.
