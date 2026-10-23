---
id: BL-0013
title: UI task edit and run history hardening
type: idea
status: open
created_at: 2026-10-23T15:50:00Z
source: IP-0002 T-0005 reviewer handoffs 1–2 and worker handoffs 1–2
promoted_to: null
---

# BL-0013: UI task edit and run history hardening

## Description

Follow-ups from the IP-0002 Tasks drawer:

- Partial-edit gap: the redacted-field guard compares the whole field. Editing part of a redacted field and leaving a `[redacted]` placeholder saves and replaces the hidden text. Refuse any save where the field still contains a placeholder from the prefill.
- `readResultFile` checks folders, then opens by path; a folder swap in between is possible (low). Compare `fstat` `dev`/`ino` with a second `lstat`, or `realpath` the opened path.
- `/api/ui-data` can read up to 4,000 `result.md` files per refresh (4 MB budget). Load result text for the selected task only, or cache `realpath(results)`.
- Cosmetic: `markdown()` shows "agent.md is empty" for a non-blank `result.md` that renders to nothing; `when()` prints only `HH:MM` for future timestamps.

## Context and evidence

- Source: IP-0002 T-0005 reviewer handoffs 1–2 and worker handoffs 1–2 (local workflow records).

## Discussion

None

## Open questions

None
