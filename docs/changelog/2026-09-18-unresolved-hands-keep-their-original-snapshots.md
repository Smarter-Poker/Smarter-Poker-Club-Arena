# Unresolved hands keep their original snapshots

The existing snapshot pruner deleted completed snapshots older than six hours
without checking whether their original F06 hand permit was still reserved.
A legacy engine can mark a preflop snapshot complete without accepting its
hand settlement. That row remains original evidence required by the owning
interrupted-hand disposition.

EarlyBird's retained read recorded a completed snapshot created at 12:47:33 UTC
on September 18. It crossed the six-hour threshold at 18:47:33 while its permit
remained reserved. By 23:03 the snapshot was absent. The installed pruning
predicate admitted it, and the existing two-minute job was active. No row-level
deletion audit establishes the precise deleting transaction.

The migration excludes an exact table and hand with a reserved F06 permit from
the existing pruning predicate. It preserves the schedule, six-hour completed
and thirty-day incomplete age boundaries, ordinary eligible pruning, batch
size, time budget, owner, privileges and security configuration. A resolved
permit permits normal retention again. It introduces no repair job, payment,
permit mutation, reconstructed snapshot or engine change.

The existing native F06 qualification reproduces deletion by the old function,
then verifies completed and incomplete unresolved witnesses survive unchanged.
It verifies normal retention, anonymous/browser refusal, installation drift
refusal, concurrent disposition rollback and commit, and pruning after the
actual owning disposition commits. Original paid custody, player stacks and
financial records remain unchanged. The existing accounting CI invokes this
qualification directly and retains its evidence.

This prevents further evidence loss. It does not recreate the already deleted
EarlyBird row or certify that event's historical disposition.
