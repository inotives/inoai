---
id: BL-0024
title: Move to a patched Node.js after the October 2026 security release
type: idea
status: open
created_at: 2026-10-24T13:20:00Z
source: human request
promoted_to: null
---

# BL-0024: Move to a patched Node.js after the October 2026 security release

## Description

The Node.js security release of 2026-10-21 fixes HIGH-severity issues on 22.x, 24.x, and 26.x. Patched versions: v22.23.4, v24.22.1, v26.12.1. It updates c-ares, the CA store, OpenSSL (22.x, 24.x), Undici, and SQLite (22.x only). The CVEs include `dns.resolve*()` NUL truncation and TLS hostname verification bypasses.

The developer machine runs v24.21.0, which is unpatched. `package.json` declares `"engines": { "node": ">=22" }` and `@types/node` `^22.0.0`, so unpatched versions are still allowed. There is no `.nvmrc` or `.node-version`. README and INSTRUCTIONS say "Node.js 22 or newer".

## Context and evidence

- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- Owner request on 2026-10-24: "due to recent nodejs major security fix, we should update our node js and we should properlly test this in this repo."
- Project-manager recommendation: a separate feature branch after IP-0004 is accepted.

## Discussion

- [2026-10-24] Captured during IP-0004 acceptance; the owner asked whether to do it in this branch or the next one.

## Open questions

- Which line to target: stay on 24.x (v24.22.1) or move to 26.x?
- Raise the `engines` floor to the patched versions (for example `^22.23.4 || ^24.22.1 || >=26.12.1`) and add a version pin file?
- Align `@types/node` with the target line?
- What counts as "properly tested": the full suite plus the 10× and 3×3 runs from IP-0004, `node:sqlite` behaviour, a live Discord/CLI smoke run?
