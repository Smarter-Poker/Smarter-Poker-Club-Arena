# User journal accounts include their club

The weekly audit found that the original deferred journal check combined an
agent's cash balances across clubs. The same grouping affected user promo
balances. In an isolated PostgreSQL database, the seven installed original
components committed opposite 10-chip changes in two clubs with no journal
rows, even though the same check correctly refused a single missing leg.
This is a safeguard defect; the audit has not identified an actual unrecorded
production transfer caused by it.

The original store producer and ledger account reader now include the club in
agent cash and user promo keys. Club and union promo banks retain their
original identities. Member and agent promo holdings within one club keep
their existing shared promo account. No wallet types, routing, balances,
historical rows, rates or payments change.

The migration checks the exact installed definitions, permissions, owner,
configuration and guard baselines, preserves their metadata and declares both
new guard definitions in the same transaction. Short NOWAIT locks on agents,
club members and the journal exclude transactions using the previous key
format. A busy writer immediately refuses installation. There is no fallback
to the old grouping, wait loop or background repair. Production installation
must use the existing merged-migration applier, once, with durable readback.

The maintained ledger qualification parent invokes the new actual-component
PostgreSQL regression. It reproduces all three old cash/promo cancellations,
then verifies missing, wrong and absent club refusals; correct journal legs;
ordinary autoledger; duplicate no-ops; unchanged bank and other account keys;
exact metadata and guard declarations; replay refusal; and atomic rollback
after a later definition mismatch. Independent open-writer cases cover all
three locked tables. The fixture's unrelated felt/tournament predicates are
typed prerequisites only, not new qualification of those scopes or wallet RPC
authorization. No tests run against production wallets.

Local results, protected checks, installation and production readback are
separate evidence recorded in the audit checkpoint. This source fix cannot
recreate missing historical pricing or MVCC observations.
