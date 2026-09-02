# 2026-09-02 - Chip Accounting Standard, Lane G: satellites and tickets

Branch `fix/chip-std-satellite`. Migration
`20260903020000_a_satellite_seat_is_paid_from_the_satellites_own_pool`
(registered in `supabase_migrations.schema_migrations` as version
`20260902201149` under that name, applied once at ~20:11 UTC).

Law test: `tests/law/SatelliteSeatIsBackedByTheSatellitePool.law.test.ts`
(row in `docs/LAWS.md`).

## Part 1 - what was measured (production, SELECT-only, last 14 days)

### The live paths, as read from `pg_get_functiondef`

- **`fn_award_satellite_seat(sat, target, user, name, position)`** (7,014
  chars live). Locks the target, applies the door-closing rules, INSERTs the
  `tournament_players` row, then `target.prize_pool += buy_in_amount`,
  `target.total_rake += buy_in_fee`, writes a `rake_records` row for the fee
  and a `tournament_payouts` row (source `satellite_seat`, amount buy_in +
  fee) on the SATELLITE. **No wallet is debited and the satellite's own
  `prize_pool` is never touched.** The seat value is minted into the target.
- **The target-unregister path is `fn_unregister_from_tournament(t)`** (the
  only body referencing the split; `atomic_tournament_unregister` is the
  legacy caller-supplied-amount variant). It does not read
  `is_satellite_qualifier` at all: it DELETEs the row and credits
  `fn_tournament_entry_split(...).charge` (buy_in + fee, or prize + bounty +
  rake) in real chips through `fn_credit_and_log`, keyed
  `tourn_unreg:<registration_id>`, then decrements the target's pools. **A
  qualifier who unregisters is paid chips they never paid in.**
- **`atomic_cancel_tournament(t, admin)`** refunds each entrant the sum of
  their `wallet_transactions` debits (`tournament_buyin|rebuy|addon`) minus
  refunds for that tournament. A qualifier has no such debit on the target,
  so `v_paid = 0` and **a cancelled target refunds the qualifier nothing.**
- **Engine finish path** (`server/src/tournament/TournamentManager.ts`
  `processSatelliteAwards`): reads the satellite's `prize_pool` ONCE
  (`pool`), builds the plan in `satelliteAwardPlan.ts` (`awardCount`,
  `remainder`), calls `fn_award_satellite_seat` per winner, pays cash
  fallbacks as `place` obligations and the remainder as a
  `satellite_remainder` obligation via `settleObligation.ts` ->
  `fn_settle_tournament_obligation` (#2671). The obligation function's
  R1-lite check excludes `satellite_seat` payout rows and compares cash paid
  against `prize_pool`. `tournamentRecovery.ts` never re-drives a satellite
  that has any seat or payout record; it closes it.

### Numbers (queries below)

| Item                                                                | Value                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Satellites ended in 14d                                             | 29 (28 COMPLETED, 1 CANCELLED)                                            |
| Completed satellites: money in (wallet debits)                      | 7,830.00                                                                  |
| Completed satellites: `prize_pool` sum (still full)                 | 7,074.50                                                                  |
| Seats awarded (`tournament_payouts.source = 'satellite_seat'`)      | 23, value 4,600.00 (all into `dfae9288` Sunday $200 Deep Stack, 180 + 20) |
| Cash paid from satellites (`wallet_transactions` prize credits)     | 6,607.00                                                                  |
| Seats + cash out vs pool in                                         | 11,207.00 out vs 7,074.50 in: 4,132.50 over                               |
| Of that, acknowledged by hand in `tournament_conservation_baseline` | 3,582.50 (11 satellites)                                                  |
| Targets cancelled with qualifiers seated                            | 0                                                                         |
| Qualifier refunds on a target (refund credit with no buy-in debit)  | 0                                                                         |
| Qualifier seats currently held                                      | 19 in `dfae9288`                                                          |

**Where chips were minted, exactly:**

1. **On the target.** 23 seats x (180 prize + 20 fee): `dfae9288.prize_pool`
   grew by **4,140.00** and `total_rake` by **460.00** (23 `rake_records`
   rows, source `fn_award_satellite_seat`) with no debit anywhere. The
   target's prize pool reads 44,640.00 against 45,000.00 of wallet debits;
   it paid 62,841.60 in prizes (the 2026-08-31 double-payment incident, Lane
   A's territory, not this lane's), and its `fn_tournament_conservation_delta`
   is -180.00 only because that function already adds the 4,600 of seat
   income back as if it had been funded.
2. **On the satellites.** The eleven satellites that awarded seats collected
   3,217.50 between them, paid 4,600.00 in seats plus 2,200.00 in cash, and
   every one still carries its full collected pool in `prize_pool`. The
   3,582.50 gap is the cashed-tickets bug already fixed on 2026-08-30 plus
   guaranteed seat counts the field never funded (`00a61dc1`: 108 pool, 5
   seats at 200; `df0145af`: 517.50 pool, 5 seats), all covered by baseline
   rows rather than by money.
3. **Destroyed: nothing in this window.** No target was cancelled and no
   qualifier unregistered, so neither of the two paths that would refund
   chips nobody paid (unregister) or refund nothing for a paid seat (cancel)
   fired. "Satellite money in = seats out was 0.00" held only because of that.

Since 2026-08-31 every satellite has paid its whole pool as cash to first
place (`dfae9288` completed, so the target is closed and `ticketCost` is 0);
no seats have been awarded for three days.

Side observation, not changed: one award bumps the target's
`current_players` by 2 (the function's own `+ 1` on top of
`trg_sync_tournament_current_players`). The engine recounts from
`tournament_players` at the end of the award loop, so it is cosmetic there.

### Queries used

```sql
-- per-satellite money in / seats / cash / acknowledged baseline
WITH sats AS (
  SELECT s.id, s.name, s.status, s.ended_at, s.prize_pool, s.total_rake, s.satellite_seats,
         t.buy_in_amount tb, t.buy_in_fee tf, t.status tstatus
  FROM tournaments s LEFT JOIN tournaments t ON t.id = s.satellite_target_id
  WHERE s.satellite_target_id IS NOT NULL AND s.ended_at > now() - interval '14 days')
SELECT left(id::text,8), name, status, prize_pool,
  (SELECT count(*) FROM tournament_payouts tp WHERE tp.source='satellite_seat' AND tp.tournament_id=x.id) seats,
  (SELECT coalesce(sum(tp.amount),0) FROM tournament_payouts tp WHERE tp.source='satellite_seat' AND tp.tournament_id=x.id) seat_val,
  (SELECT coalesce(sum(w.amount),0) FROM wallet_transactions w WHERE w.type='credit' AND w.category='prize' AND w.related_entity_id=x.id) cash,
  (SELECT coalesce(sum(w.amount),0) FROM wallet_transactions w WHERE w.type='debit' AND w.category IN ('tournament_buyin','rebuy','addon') AND w.related_entity_id=x.id) money_in,
  (SELECT coalesce(sum(b.amount),0) FROM tournament_conservation_baseline b WHERE b.tournament_id=x.id) ack
FROM sats x ORDER BY ended_at;

-- cancelled targets with qualifiers, and qualifier refunds on a target
SELECT t.id FROM tournaments t
 WHERE upper(t.status) IN ('CANCELLED','CANCELED') AND t.updated_at > now() - interval '14 days'
   AND EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id=t.id AND tp.is_satellite_qualifier);
SELECT w.* FROM wallet_transactions w
 WHERE w.type='credit' AND w.category='refund' AND w.created_at > now() - interval '14 days'
   AND w.related_entity_id IN (SELECT satellite_target_id FROM tournaments WHERE satellite_target_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM wallet_transactions d WHERE d.user_id=w.user_id AND d.related_entity_id=w.related_entity_id
                     AND d.type='debit' AND d.category IN ('tournament_buyin','rebuy','addon'));

-- the target's side
SELECT prize_pool, total_rake,
  (SELECT coalesce(sum(r.rake_amount),0) FROM rake_records r WHERE r.tournament_id=t.id AND r.source='fn_award_satellite_seat') seat_fee_in,
  (SELECT coalesce(sum(tp.amount),0) FROM tournament_payouts tp WHERE tp.source='satellite_seat' AND tp.metadata->>'satellite_target_id'=t.id::text) seat_value_in,
  public.fn_tournament_conservation_delta(t.id)
FROM tournaments t WHERE t.id::text LIKE 'dfae9288%';
```

## Part 2 - what was built

**Inside `fn_award_satellite_seat` only** (CREATE OR REPLACE of the live
body, every existing behaviour kept: door-closing rules, finalized-pool
refusal, capacity, `held_from_this_satellite` / `origin_unknown` on a dedupe,
the rake row, the payout record, the alerts):

- After the target is credited, the function locks the satellite's
  `tournaments` row, moves `LEAST(satellite.prize_pool, buy_in + fee)` out of
  `satellite.prize_pool`, and writes ONE `chip_ledger` row:
  `prize_liability(satellite) -> prize_liability(target)`, category
  `tournament_buyin`, amount moved, key
  `tourney:<sat>:seat:<user>:pool_transfer` (unique index
  `ux_chip_ledger_idempotency_key`), `pre_from_balance` / `post_from_balance`
  set, metadata naming both events, the seat and the shortfall.
- If the pool cannot cover the seat: it moves what the pool holds (to 0) and
  files **warning** `financial_alerts.source = 'satellite_seat_unbacked'`
  (deduped per satellite + user via `fn_raise_server_financial_alert`) with
  `shortfall`. The seat is awarded exactly as before. This is the guarantee
  overlay nobody funded, named instead of silently minted.
- The whole transfer block is `BEGIN ... EXCEPTION WHEN OTHERS`: any failure
  files `ca_ledger_write_failures` plus the same warning
  (`kind: satellite_seat_transfer_failed`) and the award proceeds untouched.
  **Nothing in this migration can refuse a seat or strand a finish.**
- The payout record now carries `pool_transfer` and `unbacked` in metadata
  and records the COLLECTED pool (read before the transfer), as earlier rows
  did. The return value adds `pool_transfer` and `unbacked`.
- `fn_satellite_conservation_audit` now reads the collected pool as
  `prize_pool + SUM(ledgered seat transfers)`, so a satellite that paid its
  seats correctly does not show as `excess_disbursed`. For every satellite
  completed before this migration the number is unchanged (no ledger rows).

Why this is safe against the engine (checked in `TournamentManager.ts`,
`tournamentRecovery.ts`, `fn_settle_tournament_obligation`): the engine
snapshots `prize_pool` before the award loop and pays the remainder from the
snapshot; recovery never re-drives a satellite with any award; R1-lite
compares cash paid (seat rows excluded) against the reduced pool, and
`cash + remainder == pool - seats` to the cent. The one theoretical re-drive
that could recompute from a reduced pool (a floor(pool/ticket) satellite
re-entering `processSatelliteAwards` after awarding) would compute
`awardCount = 0` and try to pay the leftover to first place as `place 1`,
which R1-lite refuses as `escrow_short`; today's body would have deduped it
on the `satellite_remainder` key instead. Both outcomes pay nothing twice.

Every other detector that reads `prize_pool` excludes satellites by variant
or `satellite_seats` (`fn_payout_guarantee_check`,
`fn_tournament_guarantee_check`, `fn_tournament_payout_reconcile`,
`fn_pay_backed_payout_shortfalls`, `fn_ca_backpay_guarantee_shortfalls`,
`fn_ca_prize_overpay_unexplained`, `fn_ca_tournament_settlement_mismatch`,
`fn_unpriced_tournaments`); `fn_tournament_conservation_delta` reads wallets
and payouts, not the counter.

A completed satellite's lobby "prize pool" will now read what is LEFT after
seats (the cash remainder), not what was collected. That is the truthful
number under this standard; if Dan wants the collected figure shown, it is
`prize_pool + ledgered transfers`, which the audit already computes.

### Rolled-back probe transcripts

Probe 1, the new body as a `pg_temp` copy, before apply (execute_sql,
`BEGIN ... ROLLBACK`). Satellite `0b9c3409` (real, completed, pool 540.00),
target `7f4bff02` (real, REGISTERING, 4.50 + 0.50), user `99be32e0` (a real
finisher of that satellite and a member of the target's club).

```
before          sat_pool 540, tgt_pool 0, tgt_rake 0
award_1         {ok:true, awarded:true, pool_transfer:5, unbacked:0, prize_contribution:4.5, rake:0.5}
after_1         sat_pool 535 (-5), tgt_pool 4.5 (+4.5), tgt_rake 0.5 (+0.5)
ledger_row      prize_liability 0b9c3409 -> prize_liability 7f4bff02, amount 5, category tournament_buyin,
                key tourney:0b9c3409-...:seat:99be32e0-...:pool_transfer, pre_from 540, post_from 535,
                performed_by 2d1cd6c3 (system), club 2a1132b9
payout_rows     [{amount 5, source satellite_seat, prize_pool 540, meta.pool_transfer 5, meta.unbacked 0}]
alerts_after_1  0
replay_2        {ok:true, awarded:false, reason:already_registered, held_from_this_satellite:true, origin_unknown:false}
replay_3        same
after_replays   sat_pool 535, tgt_pool 4.5, tgt_rake 0.5, ledger_rows 1     <- nothing moved twice
-- unbacked path: pool set to 3.00 inside the same transaction, new user
unbacked_award  {ok:true, awarded:true, pool_transfer:3, unbacked:2}
unbacked_after  sat_pool 0; alert warning satellite_seat_unbacked
                "... its pool held only 3.00: 2.00 of that seat is a guarantee overlay nobody funded. The seat was awarded."
                ctx {moved 3, shortfall 2, seat_value 5, satellite_pool_before 3, dedupe_key sat_unbacked:<sat>:<user>}
zero_pool_award {ok:true, awarded:true, pool_transfer:0, unbacked:5}        <- awarded, no ledger row, second warning
zero_pool_after sat_pool 0, tgt_pool 13.5, tgt_rake 1.5, alerts_open 2, ledger_rows 2
ROLLBACK
```

Probe 2, the LIVE function after apply, same pair, rolled back:

```
live_award   {ok:true, awarded:true, pool_transfer:5, unbacked:0}
live_deltas  sat_pool 540.00 -> 535.00, tgt_pool 0 -> 4.50, tgt_rake 0.0000 -> 0.5000, ledger_rows 1
live_replay  {ok:true, awarded:false, reason:already_registered, held_from_this_satellite:true}, sat_pool_after 535
ROLLBACK
```

After rollback: 0 `pool_transfer` ledger rows, 0 `satellite_seat_unbacked`
alerts, `fn_satellite_conservation_audit(336)` returns 0 rows (as before).

The post-apply assertion blocks in the migration file were run again
standalone against production after apply (`assertions_pass`); the second
block (the 2026-08-31 door-closing guards plus the transfer marker) was added
to the file after the apply because `satelliteDoubleQualification.guard.test.ts`
pins it on whichever migration owns the function last.

### Tests

```
npx vitest run tests/law/SatelliteSeatIsBackedByTheSatellitePool.law.test.ts tests/law-registry.law.test.ts
  Test Files 2 passed | Tests 60 passed
cd server && npx vitest run src/tournament/aSatelliteSeatIsAPayout.law.test.ts \
  src/tournament/satelliteDoubleQualification.guard.test.ts \
  src/tournament/satelliteTargetOpen.test.ts src/tournament/satelliteSecondWinIsNeverZero.test.ts
  Test Files 4 passed | Tests 45 passed
npx tsc --noEmit   (root)   clean
```

## Not built, and why

- **Unregister returns a ticket.** `tournament_tickets` exists and has a
  redemption path, but it is the CASHIER's ticket: `issued_by` is NOT NULL
  and must be an agent/owner, `fn_cancel_tournament_ticket` refunds the
  ISSUER, and `fn_redeem_tournament_ticket` pays the holder's WALLET in chips.
  A ticket written there for a qualifier is a wallet refund with one extra
  click, not a seat liability; the standard's `ticket_liability` (a ticket
  redeemable only into a tournament's escrow) needs a redeem-into-tournament
  path that does not exist. So `fn_unregister_from_tournament` is unchanged.
  Note that after this migration the chips it refunds to a qualifier ARE
  backed: the satellite pool paid the seat value into the target, and the
  unregister takes that value back out of the target's pools and hands it to
  the player. Conservation holds; whether the player should get cash at all
  is Dan's call (below).
- **Cancelled target refunds the qualifier nothing.** Dan's decision, below.
  Building either answer changes who gets money.
- **`awardCount` capped by affordability / overlay funded from a bank.**
  Both can reduce or refuse a seat award: high risk under the swarm rule.
  The unbacked warning now names the exact overlay per seat instead.
- **Backfilling ledger rows or reducing `prize_pool` on the 11 historic
  satellites.** Moving counters by migration is forbidden by the brief; the
  baseline rows already reconcile them.

## Decisions that are Dan's

1. **A qualifier who unregisters from the target: cash, or a ticket?** Today
   they receive buy_in + fee (200 on the Sunday $200) in chips, funded (as
   of this migration) by the satellite pool that bought the seat. The
   standard says a ticket, never cash, but the platform has no
   tournament-redeemable ticket yet. Options: (a) leave cash; (b) refuse
   unregistration for `is_satellite_qualifier` rows (the seat is
   non-refundable, the way most rooms treat satellite seats); (c) build
   `ticket_liability` (a ticket redeemable only into a future event of
   > = value) and return that. (b) is one line and zero money risk; (c) is a
   > feature.
2. **A cancelled target with qualifiers seated:** today they get nothing
   (their seat value stays in the cancelled target's counters and is zeroed
   by `atomic_cancel_tournament`). Options: refund the seat value to the
   wallet as cash, or to the ticket in (1c). This has not happened in 14
   days; the exposure per qualifier is the full seat value.
3. **Lobby display of a completed satellite's pool** now shows what is left
   after seats, not what was collected. Say if the collected figure should be
   shown instead.
