---
id: BL-0007
title: Natural-language task creation and management in Discord
type: idea
status: promoted
created_at: 2026-10-23T14:04:28Z
source: human request
promoted_to: IP-0003
---

# BL-0007: Natural-language task creation and management in Discord

## Description

`/inoai task create goal:… type:… interval:… unit:…` is rigid. The owner wants to ask for tasks in ordinary chat, for example "every weekday at 9, check the failing CI jobs and give me a short summary", and to manage them the same way ("pause the CI summary", "run it now"). Planned as the second of two features; IP-0002 (task model, scheduler, result files, UI task management) comes first.

## Context and evidence

- Owner request, 2026-10-23: "something like chatting with agent in discord when agent detect certain keyword like 'i want you to create an recuring tasks about ... what ... then output expected ... when ...' it is not like /task <task_id> ... that is so rigid".
- Depends on the IP-0002 task model (title, instruction, expected output, schedule, time zone).

## Discussion

- [2026-10-23] Agreed direction (owner accepted the recommendations):
  - The agent itself proposes tasks. A short instruction is added to each turn's prompt; when the owner asks for scheduled or later work, the agent adds a structured task block to its reply. inoai removes the block, validates it, and shows a task card with Create / Edit / Cancel buttons. This was chosen over keyword detection plus a separate extraction call.
  - A confirm click is required before a chat-proposed task is saved.
  - Management requests ("pause", "run now") use the same confirm-card pattern; `/inoai task …` stays as a fallback.
  - Proposed tasks must be stored durably until confirmed: either a `draft` task state (needs a tasks table rebuild) or a `task_proposals` table. Decide when this feature is planned.
  - Tasks created from Discord use an owner time-zone setting in the agent's `.env`.
  - Possible extra: stopping a run that is already in progress (needs the running agent).

- [2026-10-23] Promoted to IP-0003 on branch `feat/discord-nl-tasks` (owner: "lets start. create a new branch."). The feature README is now canonical.
- [2026-10-30] Archived: its feature was accepted.

## Open questions

- Draft state versus a proposals table.
- Exact owner time-zone setting name and default.
