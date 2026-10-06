# ADR 0016: Organize the codebase around capability modules

## Status

Accepted for the source-structure refactor.

## Context

The application has grown around a large composition file and several modules
that mix orchestration, infrastructure, and policy. The next refactor must make
the codebase easier to navigate and extend without changing runtime behavior,
persistence semantics, or CLI and Discord behavior.

## Decision

Use capability-oriented module boundaries for the refactor. The initial
boundaries are conversation, memory, persistence, runtime, transport, and
platform. Avoid generic buckets such as `utils`, `services`, and `helpers`.

Keep dependencies directed inward toward stable application interfaces. The
composition root assembles concrete transport, runtime, persistence, and memory
implementations. Capability modules depend on narrow interfaces rather than
concrete infrastructure adapters.

The first implementation slice extracts CLI parsing, startup validation,
runtime-home lifecycle, and dependency composition from `src/index.ts`. Later
slices move capability internals incrementally, carrying focused tests with the
code. `OperationalStore` remains the sole operational persistence interface;
the older `database.ts` module is isolated as a legacy/UI SQLite implementation.

Capability entry points remain explicit rather than using broad barrel exports.
Dependency direction is initially enforced with TypeScript interfaces,
directory conventions, focused architecture tests, and review; no new
import-boundary tool is required for this phase.

The refactor is behavior-preserving. Each structural change must retain the
existing external behavior, persistence contracts, and security boundaries.

## Consequences

Related behavior has a predictable home, and future adapters can be added at
the edges. Tests can exercise capability logic without starting Discord or a
real agent CLI. Tests move with their capability and the existing end-to-end
suite remains the behavior guard. The work requires deliberate dependency
untangling and staged moves rather than a single mechanical directory rename.
