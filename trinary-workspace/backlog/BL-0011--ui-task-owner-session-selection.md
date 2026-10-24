---
id: BL-0011
title: UI task creation may copy a disabled owner's session
type: bug
status: promoted
created_at: 2026-10-23T15:23:00Z
source: IP-0002 T-0004 reviewer handoff 1
promoted_to: IP-0004
---

# BL-0011: UI task creation may copy a disabled owner's session

## Description

UI task creation copies user, workspace, and provider from the most recent owner session. The query in `src/ui/api/task-writes.ts:100-102` does not filter `u.state = 'active'`, so a newer session of a disabled former owner can be copied into the placeholder session. Thread routing still works because it uses the message author, but attribution and the copied provider or workspace can be wrong.

## Reproduction

- Steps to reproduce: in a temp home, create sessions for two owner users, disable the one with the newer session, then create a task from the UI.
- Expected: the placeholder session uses the active owner.
- Actual: it uses the disabled user's session (`user_id = 2` in the reviewer probe).

## Context and evidence

- Source: IP-0002 T-0004 reviewer handoff 1 (local workflow record).
- Fix idea: add `AND u.state = 'active'`.

## Discussion

None

## Open questions

None
