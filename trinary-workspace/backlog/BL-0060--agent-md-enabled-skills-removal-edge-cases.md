---
id: BL-0060
title: Old Enabled Skills removal ignores code fences and a second section
type: bug
status: open
created_at: 2026-11-13T22:08:53Z
source: RF-0003 independent review
promoted_to: null
---

# BL-0060: Old Enabled Skills removal ignores code fences and a second section

## Description

`withoutEnabledSkillsSection` (`src/inoai/agent-instance/profile.ts`) removes an old `## Enabled Skills` section from `agent.md` before composition. It does not track code fences. If the section's body has a fenced block with a `## ` line, removal stops inside the fence and leaves the fence unbalanced, which can wrap the appended `## inoai Safety` text in a code block. It also removes only the first `## Enabled Skills` section. A second one stays in the composed output and repeats the managed heading. Both are rare. The default template has neither.

## Reproduction

- Steps to reproduce:
  1. Write an `agent.md` whose `## Enabled Skills` body contains a fenced block with a `## x` line.
  2. Compose the instructions with `loadAgentProfileWithSkills`.
- Expected: the whole old section is removed, and `## inoai Safety` is outside any fence.
- Actual: the removal stops at `## x` inside the fence. The fence stays open, so the text that follows is inside a code block.

## Context and evidence

- RF-0003 independent review, minor notes. Role parsing became fence-aware in IP-0008 T-0011 (`scanLines` in `src/inoai/roles/role-file.ts`), so that logic could be reused here.

## Discussion

- None yet.

## Open questions

- None
