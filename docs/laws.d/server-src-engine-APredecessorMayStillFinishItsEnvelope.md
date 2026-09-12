# server/src/engine/APredecessorMayStillFinishItsEnvelope.law.test.ts

An accepted hand commits an immutable post-commit envelope with it, and
`processHandPostCommitObligations` says in its own contract that consuming that
envelope "deliberately carries no dealer lease": the durable hand receipt
authorizes it, and the database converges concurrent callers exactly once with a
per-table `pg_advisory_xact_lock`, a `SELECT ... FOR UPDATE` and an
`already_completed` receipt. The engine's drain loop was nevertheless gated on
`lifecycleCanMutate()`, a dealer-lease check, so on the single path the barrier
exists for - a hand committed by an engine whose twenty-second proof lapsed
while the settlement was in flight - the loop body never ran. `attempt` stayed
0 and the give-up branch filed a CRITICAL financial alert about abandoning an
envelope this process had never once tried to apply: 935 of 949 such alerts
all-time carry `attempts: 0`, 414 of them in eight hours on 2026-09-12. This law
requires that a predecessor gets at least one attempt at its own envelope, that
the give-up alarm can never be raised with zero attempts behind it, that the
handover to the projection worker is bounded by a clock rather than a lease, and
that `postCommitStateCanReflect` still fences process-local reflection on the
lease - only the drain loses the lease term, never the reflection.
