# Committed tournament payout terms

Run `python3 scripts/dev/probe-committed-payout-terms-pg17.py`. The probe creates
and disposes a private PostgreSQL 17 cluster with no TCP listener or remote URL.

The exact installed overlay trigger and entry-close function reproduced two
independent five-place to four-place rewrites despite existing paid prizes. The
forward migration preserves finalized/prepared terms and refuses contradictory
prepared financial evidence without a finalized pool. The existing paid-prize
mutation guard is unchanged.

Captured launch begin/completion, receipt immutability, entry-close acceptance,
current versioned payout math and durable wake functions run against synthetic
tables. Every captured body is checked against its recorded MD5. Coverage
includes 34-entrant played recovery, lost replies, exact stored ladder/prize
preservation, fresh field generation, Spin aliases, malformed committed terms,
prepared contracts, concurrent parent-lock handoff, four concurrent closers,
rollback, private-role denial, drift rejection and migration replay.

The guarantee provider, alert delivery and maintenance response are explicit
stand-ins. This is not full production trigger-chain, wallet/provider, real-hand,
terminal settlement, protected CI or served adoption proof. The old event's
already-written incorrect receipt and rank conflicts require separate evidence
and reconciliation; this migration never changes an event or financial row.
