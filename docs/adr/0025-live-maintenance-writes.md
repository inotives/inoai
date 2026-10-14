---
status: accepted
---

# Live maintenance writes use a short-lived SQLite connection

The Runtime Home Lock remains held for the full lifetime of an Agent Instance because it prevents a second runtime from taking ownership; it is not the SQLite write lock. Supported local administration commands will use a short-lived connection to the same SQLite database, with SQLite transactions coordinating writes. This was chosen over routing commands through Robin to preserve the local CLI workflow without adding IPC or Discord administration commands. The initial scope is allowlist add/disable and local Memory add/delete/list. A maintenance write waits at most the existing 5-second SQLite busy timeout, then returns a clear retryable error. Robin must not be stopped, and a maintenance write must not lose or fail a Discord message or change an in-flight Turn; a short transaction-level wait is acceptable.
