---
id: BL-0046
title: Escape web source titles in the Sources list
type: idea
status: open
created_at: 2026-11-12T17:13:03Z
source: IP-0007 T-0004 reviewer handoff
promoted_to: null
---

# BL-0046: Escape web source titles in the Sources list

## Description

The `anthropic-api` `Sources:` list posts web page titles as Discord markdown. A title such as `[text](url)` renders as a masked link, and each URL may create a link embed. Mentions are already suppressed. Consider escaping `[`, `]`, `(`, and `)` in titles, and wrapping URLs in `<...>`.

## Context and evidence

- IP-0007 T-0004 reviewer handoff (follow-ups), 2026-11-12.

## Discussion

- None yet.

## Open questions

- Should embeds be suppressed for all source URLs?
