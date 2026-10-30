---
id: BL-0019
title: Single-executable macOS build of the core
type: idea
status: promoted
created_at: 2026-10-24T07:00:00Z
source: owner discussion after IP-0003 (Rust rewrite question)
promoted_to: PR-31
---

# BL-0019: Single-executable macOS build of the core

## Description

Ship the core as one executable file instead of `node dist/index.js` plus `node_modules`. The owner's main reason for considering a Rust rewrite was distribution; a Node single executable application (SEA) solves most of it without a rewrite.

## Reproduction

None

## Context and evidence

- Source: owner discussion, 2026-10-24.
- Why the repo fits SEA:
  - SQLite uses the built-in `node:sqlite`; there are no native add-ons.
  - Runtime dependencies are only `discord.js` and `pg`, both plain JavaScript.
  - UI pages are rendered from TypeScript (`src/ui/pages/*.ts`), so there are no static files to ship.
  - The project targets Node `>=22`; the developer machine runs Node 24.
- Likely steps:
  1. Bundle `dist/index.js` and dependencies into one script with `esbuild` (the package is ESM).
  2. Generate the SEA blob and inject it into a copy of the `node` binary with `postject`.
  3. Ad-hoc sign on macOS with `codesign --sign -`.
  4. Add an `npm run package` script that outputs, for example, `inoai-darwin-arm64`.
  5. Verify the binary matches `node dist/index.js`: start, `ui`, `validate`, the runtime home lock, Task Runs, and agent CLI spawning.
- Limits:
  - About 100 MB per binary (it contains Node).
  - The agent CLIs (Codex, Claude Code, OpenCode) must still be installed and signed in.
  - One build per platform and architecture.
  - Distribution to other Macs without Gatekeeper warnings needs a Developer ID signature and notarization.
  - The separate Electron UI app is out of scope.
- Rejected for now: a full Rust rewrite (about 12,300 source lines and 13,800 test lines, 27 ADRs; several weeks; little runtime benefit because inoai mostly waits on agent CLIs and Discord). `bun build --compile` is a possible alternative, but `node:sqlite` compatibility in Bun must be checked first.

## Discussion

- [2026-10-24] Recheck on `main` at `16b551c`: facts confirmed. Additions: the UI loads an icon stylesheet from `cdn-uicons.flaticon.com` (`src/ui/pages/app-shell.ts:12`), so it needs network access for icons; `pg` is used only by the optional PostgreSQL tools and could be left out of a bundle; README still describes a sibling Electron UI app (see BL-0014).
- [2026-10-30] Delivered outside the Trinary workflow by PR #31 (commit `b345db0`, "Add standalone CLI for agent deployment"): `npm run build:standalone` bundles with esbuild, injects a SEA blob with postject, and ad-hoc signs with codesign; `npm run test:standalone` verifies it. RF-0001 later fixed its launcher for Node 26. Archived.

## Open questions

- Which targets: Apple Silicon only, or also Intel Macs?
- Is Developer ID signing and notarization needed, or only local use?
- Should the deployment folder layout in the README change to a single binary plus runtime homes?
