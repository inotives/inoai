---
id: BL-0028
title: Skill-file viewer says "agent.md is empty"
type: bug
status: open
created_at: 2026-10-30T17:03:00Z
source: IP-0005 T-0006 worker and reviewer handoffs
promoted_to: null
---

# BL-0028: Skill-file viewer says "agent.md is empty"

## Description

The UI skill-file viewer (`src/ui/pages/app-shell.ts`, about line 677, `markdown(file.text, true)`) uses the default `emptyText` of `markdown()`. A skill `.md` file that renders to nothing shows "agent.md is empty". Pass a skill-specific message, as the run viewer does since IP-0005 T-0006.

## Reproduction

- Steps to reproduce: add a skill whose `.md` file holds only front matter; open it in the UI skills view.
- Expected: a message about the skill file.
- Actual: "agent.md is empty".

## Context and evidence

- IP-0005 T-0006 worker and reviewer handoffs (local workflow records). Pre-existing; cosmetic.

## Discussion

None

## Open questions

None
