---
id: BL-0061
title: Cap or hide key names echoed in connections.json error messages
type: idea
status: open
created_at: 2026-11-13T23:26:03Z
source: IP-0009 T-0002 reviewer handoff 2
promoted_to: null
---

# BL-0061: Cap or hide key names echoed in connections.json error messages

## Description

`connections-file.ts` refuses `env` and `headers` key names that match `secretLike`. It still echoes other key names in validation messages. Those messages reach the CLI and, from T-0004 on, Discord notices. A high-entropy secret pasted as a key name, with no prefix that `secretLike` recognizes, would be echoed. A length cap on echoed keys, or naming only the key's position, would close this.

## Context and evidence

- [T-0002 reviewer handoff 2](../features/IP-0009--external-app-connections/tasks/T-0002--connections-file-and-cli/handoffs/20261113_232603--reviewer-handoff-2.md), Follow-ups. Low risk: it needs the owner to paste a secret as a key name.

## Discussion

- None yet.

## Open questions

- None
