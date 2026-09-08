# Atomic Satellite Settlement

## What Was Wrong

Satellite completion was split across process memory and repeated database
calls. TypeScript calculated a seat count, invoked a per-winner seat RPC,
sometimes substituted cash, paid a remainder through another path, stamped
presentation fields, settled rake and finally closed the event. A failure
between those steps could leave a seat without its pool transfer, money without
complete evidence, or prize-pool chips retained for a later repair. The old
remainder fallback could also pay a ticket winner instead of the one player who
actually bubbled.

## Root Repair

The atomic satellite migration installs one service-facing database door:
`fn_settle_satellite_tournament(tournament_id, observed_winner_id)`.

- It locks the source, surviving target, both rosters and escrow accounts, and
  requires the source prize pool to be finalized.
- The locked source pool, not the house bank, is decomposed into
  `floor(pool / ticket_cost)` complete ticket awards and
  `pool mod ticket_cost` residual chips.
- Every complete ticket is an immutable per-place line. A provably available
  target receives an actual registration plus its exact pool-transfer and fee
  evidence. A definitively closed, full or immutably priced missing target, or
  an independently held target seat, receives an exact-price cash substitute.
  Ambiguous admission or seat provenance aborts the transaction.
- When the residual is positive, exactly one next finisher at
  `ticket_award_count + 1` receives all of it. The residual is never split,
  retained, funded by the house, or redirected to a ticket winner.
- Advertised guarantees remain promises: the existing lock-time funding rail
  must have placed enough money in the finalized source pool to cover them.
  Settlement checks that fact and refuses an unfunded guarantee rather than
  minting it again.
- Registration, wallet credits, payout and obligation evidence, target pool
  transfer, target fee attribution, prize caches, source escrow drain, rake and
  `COMPLETING -> COMPLETED` are one transaction. A malformed terminal receipt
  is not success.
- Before taking any row lock, both cash and satellite terminal authorities take
  the same transaction-scoped settlement lock. Concurrent events that pay the
  same wallets therefore cannot invert recipient locks and deadlock each other.
- Source seats are released before the tournament becomes terminal, and source
  tables close immediately after it becomes terminal. That parent-before-child
  order prevents the existing live-table guard from misclassifying a legitimate
  settlement close as an accidental close under a live tournament.
- Before any payer runs, the authority locks and freezes every source table and
  source seat identity in deterministic order. After the ticket, Bubble, rake
  and escrow work, it releases every live source seat and closes every source
  table with `status = closed`, `lifecycle = closed` and
  `current_players = 0`. Those exact identities and counts are stored in the
  immutable receipt. Replay refuses any missing, added, revived or reopened
  source row.

The former `fn_award_satellite_seat` door is deliberately retired in a separate
stage-two migration, applied only after the new engine build is published and
verified and every old instance has drained. This keeps old instances able to
finish live satellites during a rolling cutover; the cleanup then revokes and
drops the old function with `RESTRICT`, after proving that no database routine
or active schedule still names it. The unused process-side arithmetic and
target-open modules were removed. The game server now requests the exact
whole-settlement receipt and retries only the same idempotent identities. If
all direct responses are lost, a read-only resolver waits behind the same
global terminal lock and then returns either the committed immutable receipt
or a definitive no-receipt `RUNNING`/`COMPLETING` state. Only that definitive
miss reopens the finish guard. An unreadable outcome raises a critical alert,
keeps the finish guard closed, stops every owned engine, and returns without a
second rake or completion path.

The stuck-COMPLETING recovery path now replays that same whole-event RPC from
one durable stored winner and validates the same v2 receipt. It no longer
counts partial payout rows or target seats, infers `already awarded`, or closes
a satellite through a process-side status write. A historical satellite that
is visibly undecided may only compare-and-set back to `RUNNING`; an unreadable
roster, absent durable winner, transport error, SQL refusal or malformed
receipt raises a critical alert and moves no additional money.

## Exact Historical Adoption

The migration contains a temporary owner-only adoption function for production
event `b066f432-2aae-4994-85c8-f9bfbfa4cd2f`. It proceeds only if every audited
fact is unchanged: a finalized 285-chip source pool, 200-chip target ticket,
beer710 at place one with one exact settled 200-chip cash leg, DETVal at place
two, no seat leg, and exactly 85 chips in source prize escrow. Under those
assertions it writes the immutable ticket line, pays DETVal exactly 85, proves
285-chip conservation and zero source escrow, then the migration drops the
adoption function. Any mismatch aborts the entire migration.

## Verification Contract

`AtomicSatelliteFinish.guard.test.ts` pins pool decomposition, one-bubble
ordinal, guarantee funding, seat/cash classification, unknown-outcome refusal,
serialized lost-response recovery, immutable replay, legacy-door retirement
and server fail-closed wiring. `satelliteSettlementRpc.test.ts` behavior-tests
identical replay, definitive refusal, commit-after-lost-response recovery,
winner identity binding and unavailable-resolver fail-closed behavior.
`satelliteSettlementReceipt.test.ts` rejects malformed counts, awards,
registrations, UUID evidence, settlement timestamps, non-v2 responses,
winners, terminal state and any award count below `floor(pool / ticket)`.
`aStuckSatelliteGoesSomewhere.law.test.ts` forbids partial-evidence completion
in recovery. The catalog SQL audit is self-aborting. The isolated closeout
rollback probe copies the installed authority into `pg_temp`, injects a table
close refusal after its money work, and proves the ticket, Bubble credit, rake,
both escrows, lifecycle, receipt, standings, source table and source seats all
return to their exact pre-call state. It then removes the fault, calls the
installed authority and full receipt verifier, and proves exact source identity
closure plus byte-identical replay. A separate PostgreSQL 17 rehearsal against
the complete production trigger stack proved the same late-failure rollback,
then a successful close with the terminal table marker equal to the receipt
timestamp and no false live-table recovery incident.
