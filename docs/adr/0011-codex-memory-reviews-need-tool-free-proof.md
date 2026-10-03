# Codex Memory Reviews require tool-free proof

Phase 6b verifies the existing Codex Memory Review implementation against the installed real CLI. The review input is synthetic and secret-free, and includes instruction-like and tool-triggering text so the security boundary is tested directly.

The 2026-10-03 probe against `codex-cli 0.159.3` did not satisfy that gate: the authenticated app-server session emitted 11 MCP startup notifications (6 `starting`, 5 `ready`). No tool or approval request occurred and the disposable project stayed empty, but MCP absence was not proven. Codex reviews therefore remain disabled. The existing wiring records a non-secret `unsupported_runtime` skip and leaves the review cursor unchanged; it must not be treated as live Codex review support.

Codex reviews may be enabled only after a new disposable probe proves that the throwaway review session exposes neither tools nor MCP servers while using the configured read-only sandbox and approval policy `never`. A correct-looking recap is not sufficient evidence. If the CLI is unavailable, unauthenticated, unsafe, or returns invalid output, inoai records the same safe skip and leaves the review cursor unchanged for a later retry. This phase does not require Discord because Memory Reviews consume archived SQLite Messages and are silent; its fixture is synthetic and secret-free.
