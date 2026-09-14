# Accepted hands finish before a waiting terminal operation

A tournament hand took B shared and T shared at entry. A terminal operation
could then take G exclusive and wait for B. When the hand mirrored an unchanged
roster seat, the F06 guard tried G shared and refused the entire hand with
`F06_RETRY_CANONICAL_LANE`. The shared-custody repair in PR4540 removed the
unnecessary T promotion; this separate G/B inversion remained.

Hand entry now takes G shared before B shared and T shared, before financial
row locks. An existing hand finishes while the terminal operation waits at G.
A terminal operation that starts first still excludes the next hand. Rolling
authorities of other tournaments remain concurrent, and this tournament's
exclusive T lane still excludes its hands. The guard, retries, financial
writers, owner, grants and SECURITY INVOKER behavior are preserved.

The migration checks the exact helper, terminal helper, F06 guard and execution
permissions before installation and checks the resulting helper afterward.

Validation: 20 native PostgreSQL 17 checks reproduce the old refusal, exercise
both entry orderings, verify parallel hands and rolling-authority exclusions,
reject source/permission drift, and verify replay and rollback. The runner is
part of the required accounting job. A separate private clone of the cold
financial fixture aligned 34 live function definitions and their actual grants,
then passed the unchanged F06 custody and accepted-hand probes before and after
the migration. The real 12-argument financial RPC reproduces the old refusal
under a queued terminal operation; the candidate commits with its receipt,
time-bank obligations and exact chip totals, replays idempotently, and then lets
the terminal operation continue. The original fixture stayed cold and unchanged.

The historical matching alerts remain individual investigations. Their common
error text alone does not establish which operation held a historical lock.
