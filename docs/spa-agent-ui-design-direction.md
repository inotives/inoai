# SPA agent UI design direction

## Design brief

inoai is a local operations console for one deployed coding agent. Its main
job is to answer one question quickly: is this agent healthy, and what has it
been doing? The owner is a technical user who needs evidence, not a marketing
dashboard.

## First-pass direction: night-shift operations desk

Use a quiet, instrument-panel composition with one memorable element: a thin
24-hour health rail that acts as the visual signature of the product. Keep the
rest of the page calm so failures and recent activity receive attention.

### Tokens

- Ink: `#0b1220` — page background.
- Slate: `#172235` — profile and content surfaces.
- Blue steel: `#243650` — metric and table rows.
- Signal mint: `#59e3b1` — healthy state and active controls.
- Signal amber: `#f2c66d` — degraded state.
- Signal coral: `#f47d79` — failure and restart state.

Use a system sans stack for readable operational copy. Use a compact tabular
number treatment for metrics, timestamps, and health markers. Keep labels in
sentence case and left-align operational content.

### Layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ inoai / selected agent                         refresh status         │
├──────────────────┬───────────────────────────────────────────────────┤
│ agent profile    │ overview summary                                  │
│ runtime status   │ message count  session count  sqlite status         │
│ provider         │ 24-hour health rail                               │
│ last heartbeat   │ recent activity                                   │
├──────────────────┴───────────────────────────────────────────────────┤
│ Overview  Conversations  Sessions  Memory  Events  Health             │
├──────────────────────────────────────────────────────────────────────┤
│ active tab content: one table or timeline with clear empty states     │
└──────────────────────────────────────────────────────────────────────┘
```

The profile remains anchored while tab content changes. Overview leads with
health evidence rather than a large decorative hero. Tables use alignment and
rules to show relationships; cards are reserved for distinct groups, not each
individual value.

## Self-critique against the brief

The first pass intentionally avoids the generic SaaS dashboard pattern: no
gradient hero, no repeated rounded metric cards as the primary structure, no
all-caps eyebrow labels, and no decorative animation. The health rail is
specific to inoai because heartbeat history is the product's operational
evidence. The palette keeps the requested dark theme but uses mint, amber, and
coral as status signals instead of a single generic accent.

The current static shell is a valid launch scaffold, but it still uses a
three-card metric row and a generic `AI` avatar. The prototype pass should
replace those with the health rail, selected-agent identity, and representative
fixture content before live SQLite wiring begins.

## Prototype acceptance notes

- Preserve all six planned tabs and the persistent profile area.
- Show healthy, degraded, failed, recovery, unknown, loading, empty, and error
  states with sanitized fixture data.
- Keep keyboard focus visible and respect reduced-motion preferences.
- Do not load `.env`, SQLite, Discord metadata, or absolute local paths.
- Use the selected runtime only as launch context; fixture content remains
  local and static until the prototype is approved.
