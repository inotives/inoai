---
id: BL-0050
title: Text after the Enabled Skills heading in agent.md is silently dropped
type: idea
status: promoted
created_at: 2026-11-13T02:24:45Z
source: IP-0007 live check
promoted_to: RF-0003
---

# BL-0050: Text after the Enabled Skills heading in agent.md is silently dropped

## Description

`renderEnabledSkillsProfile` replaces everything from `## Enabled Skills` to the next section, or to the end of the file, with the harness-owned skill index. That section is last in the default profile, so text appended to the end of `agent.md` is silently dropped for every provider. Consider warning in `profile validate` when that section has owner text, or documenting it in the `agent.md` template.

## Context and evidence

- IP-0007 live check, 2026-11-13: an instruction appended to robin's `agent.md` never reached the model.

## Discussion

- [2026-11-13] Promoted to RF-0003 (streamline the agent.md format). `## Enabled Skills` is no longer part of `agent.md`; an old section is ignored and `profile validate` warns about it, so owner text under later headings is kept.

## Open questions

- None
