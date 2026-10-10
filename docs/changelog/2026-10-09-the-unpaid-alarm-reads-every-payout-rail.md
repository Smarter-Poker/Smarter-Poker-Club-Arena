# 2026-10-09 - the unpaid alarm reads every payout rail, and satellites get their lock

## What Dan saw

A push at 18:12 CT: "Money Check Failed from Smarter.Poker - 2 Completed
Tournament(s) With A Prize Pool And No Payout. 5 More Of This Kind Since The
Last Alert." His questions: why is this on his phone instead of going to
Production Alerts and being fixed automatically, how are tournaments still
failing to pay with an atomic payout system, and what makes it impossible.

## What was true

Nobody was unpaid. Measured read-only 2026-10-09 ~23:55 UTC:

- 2026-10-02..10-09: 204,191 completed tournaments with a prize pool, 0 with
  no delivery on any rail.
- `TournamentCompletedUnpaid` first fired 2026-10-07 13:19 UTC, the day Diamond
  Arena events began finishing, and has no earlier row in
  `operational_alert_events`. Since 6 hours before that first firing the gauge
  flagged 32 tournaments. All 32 are Diamond Arena events (club
  `002c2d27-...` "Diamond Arena"); for all 32 the Diamond prize rows equal the
  prize pool exactly (143,069 of 143,069 Diamonds), and every prize row carries
  its `diamond_transactions` journal row for the same player, written in the
  same second the event ended.

## Why it paged

`TournamentCompletedUnpaid` is `poker_tournaments_unpaid_completed > 0`, read
from `fn_tournament_metrics().unpaid_completed`. That count accepted a payout
only as a chip `wallet_transactions` row with `category = 'prize'` or a
`tournament_satellite_awards` row. A Diamond Arena event pays through
`fn_poker_diamond_tournament_pay`: a `poker_diamond_tournament_ledger` prize
row and its Diamond journal, never a chip wallet row. So every Diamond event
with a prize pool read as "nobody was paid". The payout reconciler reads
`tournament_payouts`, found each pool fully discharged and correctly did
nothing, which is exactly the condition the alert's text describes as "both
have declined to act and it needs a human".

It reached the phone through `zz_a_real_alert_reaches_the_owner` (migration
20261007000825), which pages the senior platform recipients for dealing,
restart and money alerts because the Production Alerts inbox had stopped being
read. It still is not being read: nothing in `operational_alert_events` has
been touched since 2026-10-08 16:04 UTC, and the Production Alerts lane A2
scheduled task on the owner's account was paused 2026-10-09 ~15:36 UTC. By
their own standing orders those lanes may not merge, deploy, install a
migration or change a production row, so they were never a path to an
automatic fix. That is unchanged here.

This is the same defect the gauge had on 2026-09-12 for satellites (twelve
firings, all paid in seats; `server/src/tournament/aSatelliteSeatIsAPayout.law.test.ts`).
Each new way of paying was added to the payout code and not to the alarm.

Every other payout check that reads chip prize rows was measured over 7 days
and reads 0 (`fn_satellite_conservation_audit`,
`fn_tournament_prize_disbursement_audit`, `fn_hu_shortfall_candidates`,
`fn_spin_unpaid_settlements`, `fn_ca_payout_rows_without_money`,
`fn_spin_metrics.unpaid_settlements`). This gauge was the only one crying wolf.

## What changed (applied to production on Dan's explicit approval, "Yes, apply all 3")

1. `20261010012101_the_unpaid_tournament_alarm_reads_the_diamond_book` -
   `unpaid_completed` counts an event as unpaid only when no rail delivered
   value: chip wallet prize, Diamond prize-ledger row with its journal, or
   satellite award. Same signature, columns and ACL. The 49
   `TournamentCompletedUnpaid` inbox rows (25 firing, 24 resolved) closed as
   `verified_fixed` with this evidence, after an apply-time proof that nothing
   in their span went unpaid on any rail and that every event the old count
   flagged was a Diamond event paid its pool exactly.
2. `20261010012144_a_satellite_completes_only_with_its_settlement_receipt` -
   MTTs, Spins and Sit & Gos already could not reach COMPLETED without their
   atomic terminal receipt. Satellites had no lock:
   `aaa_guard_atomic_satellite_completion` (20260908125910) was installed
   disabled pending a "Stage B" that never ran, and it checks
   `tournament_satellite_settlement_batches`, which the live engine does not
   write (221 of 221 satellites in 3 days fail it), so it must stay disabled.
   The new deferred constraint trigger `satellite_completed_requires_settlement_receipt`
   refuses COMPLETED for any satellite without its
   `tournament_satellite_settlements` receipt and a closed source escrow,
   checked at COMMIT. All 2,548 satellites completed since 2026-09-10 03:00 UTC
   already satisfy it, written in the same transaction as their completion. A
   path that tries to finish a satellite without paying it now rolls back and
   leaves the event COMPLETING, where `ca-tournament-finished-not-completed-5m`
   sees it, instead of COMPLETED with nobody paid.
3. `20261010012636_the_satellite_lock_is_a_declared_money_trigger` - the
   declaration (2) should have carried in the same migration
   (`check-money-trigger-declared`). The trigger was live undeclared for five
   minutes; `UndeclaredTriggerOnAMoneyTable` was already firing for the older,
   unrelated `club_wallets.poker_arena_no_chip_rake`, so no new page went out.
   `fn_undeclared_money_triggers()` no longer lists the lock.

All three files are byte-identical recordings of what production ran, listed
in `scripts/ci/recorded-migrations.manifest.json` with their live evidence.

## The pin

`tests/the-unpaid-alarm-reads-every-payout-rail.law.test.ts` reads the newest
definition of `fn_tournament_metrics` and requires every rail in its RAILS
list; a new payout rail is added there and to the function in the same pull
request. It also requires the satellite lock, its register row, and that no
later migration drops or disables either completion lock or enables the
obsolete batch guard.

## Verified live after apply (read 2026-10-10 01:34 UTC)

- `fn_tournament_metrics(10,10,6).unpaid_completed` = 0, and 0 over 168 hours.
- `TournamentCompletedUnpaid`, firing since 2026-10-09 23:11 UTC, resolved at
  01:22:26 UTC, 85 seconds after the gauge fix was applied. No owner page has
  been sent since the 23:11 one.
- Both completion locks enabled and deferred; the batch guard disabled.
- 293 tournaments completed in the first twelve minutes under the new lock,
  3 of them satellites, each with its receipt and closed escrow; 0 tournaments
  in COMPLETING.
- `fn_tournament_metrics` keeps ACL `{postgres=X/postgres,service_role=X/postgres}`
  (anon and authenticated cannot execute it); the lock's trigger function is
  `{postgres=X/postgres}`; `fn_definer_exposure_audit()` lists neither.

## Still open, not part of this change

- `club_wallets.poker_arena_no_chip_rake` is undeclared and has kept
  `UndeclaredTriggerOnAMoneyTable` firing since 2026-10-05.
- The Production Alerts inbox has no running reader.
