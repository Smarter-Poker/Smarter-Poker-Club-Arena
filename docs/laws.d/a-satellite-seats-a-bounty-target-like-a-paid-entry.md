# tests/a-satellite-seats-a-bounty-target-like-a-paid-entry.law.test.ts

A satellite seat into a bounty, PKO or mystery-bounty target is booked exactly
like a paid entry (Dan, 2026-10-16: "EVERY TOURNAMENT WITH A 25 BUY IN OR
HIGHER SHOULD HAVE SATELLITES INTO IT"). Both settlement authorities split the
seat with the paid door's own `fn_tournament_entry_split`: the prize slice to
the prize ladder, the bounty slice to the bounty rail as a funded head on the
seat row, the fee to the fee rail, with the target's counters, escrow, refund
entitlement and any capped winner's noncash ticket all carrying the same
split. A Spin, a premium Spin, unknown flags, a bounty larger than the buy-in
and a Diamond bounty target are still refused by name. Re-adding the old
refusal, or seating a bounty target without the split (the 2026-09-04 PKO that
handed 66 entrants 4,455.00 against an advertised 5,810.00), fails this law;
`scripts/ci/test-satellite-bounty-seat-split.py` executes the migration's own
postimages on PostgreSQL 17 and ends that field funded at exactly 5,810.00.
