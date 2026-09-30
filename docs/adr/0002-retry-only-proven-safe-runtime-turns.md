# Retry only proven-safe runtime turns

A failed or timed-out Codex turn may already have changed files or used tools before inoai sees an error. Replaying such a turn could duplicate side effects, so inoai retries at most three times with bounded backoff only when the turn never started or the runtime proves it had no side effects. An uncertain outcome fails closed, is recorded, and requires a fresh owner request. Phase 5 must apply the same rule to stale `processing` messages on restart; SQLite queue state alone is not proof that replay is safe.
