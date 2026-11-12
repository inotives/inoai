---
id: BL-0044
title: Show fetched pages in the API runtime's Sources list
type: idea
status: open
created_at: 2026-11-12T17:09:30Z
source: IP-0007 T-0004 worker handoff
promoted_to: null
---

# BL-0044: Show fetched pages in the API runtime's Sources list

## Description

The `anthropic-api` runtime's `Sources:` list uses only `web_search_result_location` citations. Pages read with `web_fetch` are not listed. Fetch citations are disabled by default, and when enabled they carry a document index and title but no URL.

## Context and evidence

- IP-0007 T-0004 worker handoff (remaining concerns), 2026-11-12.
- SDK 1.8.0: `BetaWebFetchTool20260209.citations`, and the `char_location` and `page_location` citation types.

## Discussion

- [2026-11-12] PM ruled search-only Sources acceptable for IP-0007.

## Open questions

- Enabling fetch citations changes the frozen tool prefix for new Sessions. Should it apply only to new Sessions?
- How should a document index be mapped to its fetched URL?
