# Inventory seal continuation retains native qualification

The bucketed inventory migration was protected-merged with source-text laws,
but its reported PostgreSQL equivalence fixture was not retained in the
repository. This change retains the exact captured preimage and runs the
actual migration in a private PostgreSQL 17 cluster through required
accounting shard three. It compares whole-week and bucketed results over
34,002 synthetic rows, including untouched base rows, repeated layer updates,
NULL images and base/layer issues. No production credentials or database are
used by the probe.

The native cases preserve rows, issues, checkpoint hashes, verification,
duplicate completion, concurrent admission, staging-loss recovery, atomic
mid-seal refusal and rollback. A separately labeled diagnostic changes only
the continuation threshold to 3,000 and needs twelve calls with no checkpoint
visible before completion. Exact migration qualification runs first. The
400,000-row and 75-second thresholds are checked between whole buckets;
the test and documentation do not claim strict per-transaction ceilings.

The accounting job retains its native transcript and row/issue digests. The
existing law pins direct invocation and fails if the required behavior probe
is removed. Production installation and affected behavior remain separate
evidence in the tournament-hardening checkpoint.
