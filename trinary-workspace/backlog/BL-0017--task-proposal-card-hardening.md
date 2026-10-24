---
id: BL-0017
title: Task proposal card hardening
type: idea
status: open
created_at: 2026-10-24T00:55:00Z
source: IP-0003 T-0004 worker handoffs 1-2 and reviewer handoffs 1-2
promoted_to: null
---

# BL-0017: Task proposal card hardening

## Description

Small robustness gaps left after IP-0003 T-0004. None block the feature.

- Cards waiting in the in-memory `cardsAfterDelivery` queue are lost on restart; the proposal stays pending without a card until expiry or replacement.
- If `finishTaskProposal` throws after a successful Create, the transport fallback says "Please try again" and the proposal stays `confirming` until restart.
- A crash during Create can leave a thread without a task; there is no automatic cleanup.
- A busy SQLite lock (5 s timeout) can make a click miss Discord's 3-second window.
- A failed card edit is not retried; a re-clicked replaced card may say "Expired" instead of "Replaced".
- The failure reason is read by listing all of a Session's events; a targeted query or stored reason column is cleaner.
- `resetSession` takes its expiry time from `Date.now()`, not the caller's clock.
- A task block shown as an example inside another code block becomes a real proposal (T-0003 reviewer).

## Reproduction

None

## Context and evidence

- Source: IP-0003 T-0003 and T-0004 handoffs (local workflow records).
- Code: `src/inoai/conversation/task-proposal-cards.ts`, `src/inoai/connectors/persistence/sqlite/legacy-database.ts`.

## Discussion

- [2026-10-24] Recheck on `main` at `16b551c`: all sub-items still open. Exact transport fallback text is "Action unavailable. Please try again." (`discord.ts:137`).

- [2026-10-24] Sub-item g (`resetSession` clock) moved to IP-0004 T-0001. This item stays open for the other sub-items.

## Open questions

None
