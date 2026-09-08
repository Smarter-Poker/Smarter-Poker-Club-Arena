# Atomic Tournament Cash Settlement

## What Was Wrong

Ordinary tournament places and final-table deals were priced and paid one
recipient at a time by the game server. A failure after an early credit could
leave part of the field paid, let the tournament continue toward completion,
and force an hourly reconciler to reconstruct the missing money later.

The wallet credit helper also treated the tournament payout row as optional
paperwork. A wallet credit could survive even when its payout evidence failed
to insert.

## Root Repair

Migration `20260908153151_tournament_cash_settlement_has_one_atomic_authority`
installs one database-owned transaction boundary for each cash finish:

- `fn_settle_tournament_places` locks the tournament, complete roster, and
  complete obligation set; atomically funds and finalizes any advertised
  guarantee; derives the winner, recipients, and exact-cent ladder; writes
  every positive place obligation before the first credit; and either commits
  every place with the winner standing and
  `RUNNING -> COMPLETING`, or commits nothing.
- `fn_settle_tournament_bubble_protection` derives the final stone bubble from
  the durable elimination sequence and pays exactly one base buy-in from the
  tournament prize pool. It is unavailable until the field and pool are final.
- `fn_settle_tournament_final_table_deal` derives unanimous eligibility,
  final-table layout, locked stacks, funded guarantee, remaining pool,
  deterministic standings, and exact-cent chip-chop shares in the same
  transaction. Its replay receipt is the authority for the server.
- `fn_credit_and_log` now makes the wallet movement and exact payout evidence
  inseparable. Missing, duplicate, malformed, wrong-recipient, wrong-standing,
  or key-mismatched evidence raises and rolls the transaction back.
- Arithmetic and one-recipient raw payers are owner-only. The service role can
  execute only the three complete cash domain doors.
- Unique partial indexes enforce one recorded finisher per tournament place
  and one database-owned elimination sequence per tournament.

The game server no longer prices or pays cash places one at a time. Normal
completion and restart recovery call the database door, require its exact
receipt, and refuse to close tables or mark the event complete unless exactly
one durable `COMPLETING -> COMPLETED` transition succeeds. Final-table deals
consume the database-ranked receipt and do not rank tied stacks again in
memory.

Satellites, bounty finalization, and the later accounting work orders remain
separate authorities. All four satellite markers fail closed at every cash
door.

## Verification

- The consolidated migration compiled in one transaction against a local clone
  of the current production schema.
- The exact installed function definitions matched the separately exercised
  behavior harness by PostgreSQL function-definition hashes.
- Ordinary-place probes proved a complete two-place debt set existed before
  the first credit, exact 70/30 settlement, no-money replay, and full rollback
  when the second place encountered a short escrow.
- Guarantee probes prove funding and payout share one transaction, an invalid
  or unfunded guarantee commits neither money nor finish state, and a completed
  replay verifies the same finalized pool.
- Bubble probes prove the buy-in is reserved before ladder pricing, exactly one
  final stone-bubble row receives it, and its durable prize cache matches the
  settlement receipt.
- Spin probes proved the locked 10x tier paid 80/20 and ignored a stale stored
  winner-take-all cache.
- Final-table-deal probes covered fresh settlement, `COMPLETING` and
  `COMPLETED` replays, prior payout evidence, tied stacks, mid-loop rollback,
  missing votes, multiple live tables, disabled deals, malformed money,
  non-roster evidence, wrong-standing evidence, and role grants.

No historical balance, payout, or obligation is changed by the migration.

## Band-Aid Retirement Gate

This is the hard fix for items 1, 2, and 4 in
`docs/BAND-AIDS-REGISTER.md`. Stage one deliberately leaves every legacy cash
function, application grant, schedule, and heartbeat byte-for-byte unchanged
while the database-first rolling deployment is in progress. Once the server
build using the atomic doors is published, its live receipts are verified, and
all pre-cutover instances have drained, stage two removes every scheduled alias
of the payout reconciler, payout sweep, backed-shortfall payer,
guarantee-backpay arm, alert resolver, and legacy final-table-deal payer. It
then drops those routines with `RESTRICT`, removes their heartbeats and money
registry entries, and revokes application access to the remaining generic
obligation primitive. No observer, throwing tombstone, alias, or later money
repair replaces them.

Stage two is held outside the automatic migration path at
`supabase/staged-migrations/20260908044246_legacy_cash_repair_fleet_retires_only_after_zero_backlog.sql`.
Its current version is only a working identifier and must be restamped after
the exact six-event historical obligation retirement and the live engine
proof. Before it
unschedules or drops anything, it takes stable share locks and refuses to run
if a non-satellite cash award is still open, a non-satellite tournament is
still `COMPLETING`, or a completed non-satellite event does not have exactly
zero enforced prize escrow. Malformed numeric state, including `NaN` or an
infinite balance, is rejected explicitly instead of comparing as though it
were zero.
