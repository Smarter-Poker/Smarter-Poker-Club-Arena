# Union membership registration before function creation

The first install of migration 20261012112707 rolled back in run 38254888948:
production correctly refused the unregistered zero-chip membership helper.
Its isolated fixture had omitted the production money-function DDL guard.

Register the helper as system before its CREATE, in the same transaction.
The membership rule, balance behavior, role, ACLs and reviewed function bodies
are unchanged. Production history confirmed the migration was never installed;
this correction edits only its unapplied source, preserving installed records.

The existing PostgreSQL qualification now rebuilds the production predicate and
event trigger from their maintained migration. It proves removal of the
registration produces the original refusal and rolls back everything, then
verifies the corrected install and all existing membership cases.

The existing member-removal PR also failed its unchanged-retry UI regression
on GitHub: a one-render boolean could be consumed before the restored form
finished rendering. The restored identifiers now belong to a canonical input
signature, survive equivalent rerenders, and clear on an actual edit. Initial
hydration shows the recovery prompt; only explicit review restores identifiers
with the form. Existing lost-response/reload, individual-amount, ticket and
intent-editing tests remain enforced.

A two-session PostgreSQL counterexample also reproduced a concurrent join and
ownership-transfer gap: the join could read the old owner, the transfer could
miss the uncommitted club link, and the join could commit with no membership
for the new owner. The helper now takes a shared lock on the union row before
choosing its owner, then the existing membership lane and row locks. An
ownership update either waits for the join or completes before its owner is
read. The regression coordinates both transactions using an advisory barrier;
it fails with the owner lock removed and passes with the corrected lock order.
