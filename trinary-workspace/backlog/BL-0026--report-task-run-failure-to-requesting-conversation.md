---
id: BL-0026
title: Report a Task Run failure in the conversation that asked for the run
type: idea
status: open
created_at: 2026-10-30T16:22:21Z
source: IP-0005 plan decision 6
promoted_to: null
---

# BL-0026: Report a Task Run failure in the conversation that asked for the run

## Description

When the owner confirms "run now" from a chat card, a failed run is reported only in the Task's own thread (`task-run-executor.ts`, the `catch` in `execute`). The conversation that asked for the run shows a confirmed card and then nothing. Post the failure, or a link to the Task thread, in the requesting conversation too.

## Context and evidence

- BL-0018 fix idea, left out of IP-0005 by the owner's acceptance of decision 6 ("yes to all", 2026-10-30). After IP-0005, provider mismatch no longer causes these failures, but other failures still report only to the Task thread.

## Discussion

None

## Open questions

- Should the report go only to a conversation that requested a run now, or also to the conversation that created the Task?
