---
id: BL-0029
title: Memory feedback loop
type: idea
status: promoted
created_at: 2026-10-30T21:57:34Z
source: human request
promoted_to: IP-0006
---

# BL-0029: Memory feedback loop

## Description

Memory is recorded but barely used. There is no feedback loop that helps the agent improve from Memory, and little new Memory comes from conversations. Make Memory visible, owner-confirmed, used in more places, and traceable, so a later feature can add feedback and lessons.

## Context and evidence

- Owner request (2026-10-30): "currently we record down the memory, but nothing much is done on it. there are no feedback loop to help agents improve based on the memory, or creating new memory from conversations."
- Creation: the daily Memory Review adds Memory only on explicit "remember…" requests or a pattern in two or more recaps (`src/inoai/memory/memory-review.ts`); manual entries via `memory add`.
- Use: `composeTurnPrompt` (`src/inoai/conversation/prompt-context.ts`) adds Memories by word overlap to chat Turns (6,000-character budget). Task runs get no Memory. Nothing records which Memories were used.
- Demo home data (read-only, 2026-10-30): 380 messages, 13 reviews, 5 review Memories and 2 manual ones, all under 80 characters; reviews mostly return `model_ignore`.

## Discussion

- [2026-10-30] Project-manager ideas: (1) show what was learned (status-channel summary, `/inoai memory`); (2) proposed Memories with confirm cards (ADR 0027 pattern); (3) core vs topic Memory, Memory in Task runs, usage records; (4) feedback from corrections and reactions, retire unused Memory; (5) procedural lessons; (6) agent-proposed `agent.md` edits. Recommendation: first feature = 2 + 3 + a slice of 1; then 4 and 5 later; 6 last if ever.
- [2026-10-30] Owner: "those are solid idea. agreed on directions".
- [2026-10-30] Promoted to IP-0006 on branch `feat/memory-feedback-loop`. The feature README is canonical from now on.

## Open questions

None
