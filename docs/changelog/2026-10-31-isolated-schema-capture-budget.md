# Use the original schema capture deadline coherently

Run41241199889 established the actual export termination: its child reached
the30-second inner deadline and was killed with SIGKILL at30013ms, with zero
stdout/stderr bytes. This proves the termination, not the underlying query,
authentication, certificate or capacity cause. Full-schema and all14 connected
cases remain unproved.

The capture now passes only its actual remaining45-second total budget to
pg_dump, reserving five seconds for snapshot closure and private finalization.
Remove the redundant30-second inner cap; preserve the original total/idle
deadline, strict provider CA, read-only snapshot, byte limits and cleanup.
Standalone dump calls retain their original default deadline. A pure boundary
regression verifies the budget without changing a clock.

The Node metadata connection retains its five-second query deadline. Native
pg_dump resets statement_timeout during startup, so its effective guards are
the bounded whole-export deadline and explicit one-second table-lock wait.
PGOPTIONS alone is not evidence of a five-second native per-query limit. No
retry, fallback, new query guard or broader timeout is added. The corrected
actual run must establish export, full-schema parity, all14 cases and cleanup.
