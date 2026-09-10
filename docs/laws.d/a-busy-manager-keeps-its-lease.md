# tests/a-busy-manager-keeps-its-lease.law.test.ts

A tournament manager in the middle of a write must not lose its lease to its
own heartbeat. The PostgREST pre-request hook holds FOR KEY SHARE (never FOR
SHARE) on the event's lease row, so the heartbeat's FOR NO KEY UPDATE renewal
is not skipped as busy; the takeover locks FOR UPDATE before its upsert so it
still waits for every in-flight manager transaction; and the engine keeps
treating a busy reply as unknown rather than extending authority on a locked
row. Pins the migration's substitution, its post-conditions and the recorded
lock matrix.
