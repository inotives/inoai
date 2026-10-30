---
id: BL-0025
title: Standalone launcher prints a vm experimental warning
type: idea
status: open
created_at: 2026-10-30T15:02:08Z
source: RF-0001 reviewer
promoted_to: null
---

# BL-0025: Standalone launcher prints a vm experimental warning

## Description

Since RF-0001, the standalone launcher loads the bundled app through `vm.Script` with `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`. Every standalone run except `--licenses` now prints `ExperimentalWarning: vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time` on stderr, next to the existing SEA experimental warning. Behaviour and exit codes are unchanged.

`runRemote` (`src/inoai/skills/skill-acquisition.ts:93-104`) copies the last 2,000 stderr characters into its failure message, so a failed remote skill install in the standalone build also carries this warning. Suppress only this warning in the generated launcher (`scripts/build-standalone.mjs`), or switch to a stable SEA ESM entry when Node provides one.

## Context and evidence

- RF-0001 independent review, finding 1 (low).
- Related minor gap from the same review: `isPatchedNode("v27.0.0-pre")` in `scripts/node-version.mjs` returns true while npm's semver range rejects prereleases. Only nightly Node builds are affected.

## Discussion

- [2026-10-30] Captured from the RF-0001 review; not fixed in RF-0001 because it is cosmetic.

## Open questions

None
