# Reset is a queue boundary

An explicit `/inoai reset` cancels the active turn, fails queued Messages without running them, and discards the current Agent Session binding. The SQLite archive remains, and the next Message starts a fresh Agent Session. Waiting for the queue to drain would let work the owner meant to abandon run before reset; replaying it into the new Session could duplicate side effects. Cancellation cannot undo work already performed, so an uncertain active outcome is reported as uncertain.
