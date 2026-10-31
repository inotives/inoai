---
id: BL-0037
title: Near-duplicate Memory proposals
type: idea
status: promoted
created_at: 2026-10-31T01:05:00Z
source: IP-0006 live acceptance check
promoted_to: IP-0006
---

# BL-0037: Near-duplicate Memory proposals

## Description

Proposal dedupe compares normalized text only (lower-case, trimmed, collapsed whitespace). Two reviews in the same cycle proposed the same news-format preference in different words, so both were stored and posted as separate cards. After the owner confirmed one (Memory #8), the other stayed pending. Consider skipping a proposal whose meaning matches an active Memory or a pending proposal, for example by listing pending proposals in the review prompt so the model does not repeat them.

## Context and evidence

- Live check in `demo-test/.inoai-connect-robin`, 2026-10-31: proposals 2 (review 17, confirmed → Memory 8) and 3 (review 18, pending) have different text for the same preference. Both reviews ran in one owner-triggered cycle (`trigger=owner; date=2026-10-31; enqueued=3`).
- `storeReviewProposals` in `src/inoai/connectors/persistence/sqlite/legacy-database.ts`; ADR 0029.

## Discussion

None

## Open questions

- None
