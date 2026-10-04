# The house pays WASP the two seats it could not deliver (2026-10-04)

Migration `20261004151352_the_house_pays_wasp_the_two_seats_it_could_not_deliver`.
Settled under CLAUDE.md 10.9. Replaces
`20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites`,
which is merged on main and refuses itself on apply.

## What happened

WASP (`a497dbb8`) bought a seat in Friday Night Feature (`cfcf5abc`, 27.00 + 3.00) with 30.00 of their own SHARK CLUB chips at 18:49 on 2026-09-03. Later that evening they won two heads-up Friday Night Feature satellites (19.00 + 1.00, one 30.00 seat each), both hosted by Midway Union (`fade0000`):

| Satellite  | Ended (UTC) | In    | Runner-up | Union fee | Left in prize liability |
| ---------- | ----------- | ----- | --------- | --------- | ----------------------- |
| `0d29dd54` | 22:30:18    | 40.00 | 8.00      | 2.00      | 30.00                   |
| `781c8905` | 22:40:24    | 40.00 | 8.00      | 2.00      | 30.00                   |

WASP already held the target seat. The seat carried no satellite origin, so the award called it unknown, paid nothing and filed `Satellite.seat_origin_unknown` "needs a human" (alerts `20abe32c`, `2e2ecd9d`). `FeeReconciler.satellite_conservation` then filed twice (`25399c02`, `71b057a7`) for exactly these two events: pool 38, seats 0 of 1, cash 8, one unpaid winner.

This is the railbirdd case of 2026-09-05 on two older events. `20260905195011` ruled that a winner who bought the target seat is paid the seat in cash, and fixed `fn_award_satellite_seat` so the engine pays it. That is the root fix and it is already live; it could not reach these two events because both were terminal when it landed.

## Why the merged migration cannot work

It paid each 30.00 out of that satellite's own `prize_liability`, writing the journal leg with `tournament_id` NULL and naming the satellite's liability as counterparty, so that no terminal-evidence guard would see a tournament. Applied through the estate's own dispatch-only route (run 37209895373) it refused itself and rolled back cleanly:

```
[apply] the migration did not commit after 249ms
[apply] ERROR 55000: completed satellite transfer journal is immutable
[apply] WHERE: PL/pgSQL function fn_satellite_transfer_ledger_is_immutable() line 74 at RAISE
```

The guard is not evaded, because it was written against exactly that evasion. Its own header says the seat transfer journal "is queried by source liability and key, not only by `chip_ledger.tournament_id`", and it resolves the source satellite from four witnesses:

1. `chip_ledger.tournament_id`;
2. `from_entity_id`, whenever `from_type` is `prize_liability`;
3. a `tourney:<id>:seat:%:pool_transfer` idempotency key;
4. `metadata.satellite_id`.

Any INSERT whose source satellite is `COMPLETED`, `CANCELLED` or carries a committed terminal receipt is refused. Naming a completed satellite's `prize_liability` is therefore exactly as forbidden as naming the satellite. Read from production for both events: status `COMPLETED`, `fn_ca_has_committed_tournament_receipt` false, so it is the plain status check that refuses, not the receipt check. (The superseded file's header and changelog both said "COMPLETED and receipted"; the receipt half was not true, and it did not matter.)

The guard's one bypass, `fn_ca_legacy_fee_resolution_write_is_exact`, admits only an exact legacy fee custody resolution to a union rake wallet or chip retirement, with its own resolution row in the same transaction. It is not this case.

**The consequence, stated plainly: each of these two satellites' `prize_liability` can never be debited again by any path.** The superseded migration's post-image, "each satellite's `prize_liability` reads 0.00", is unreachable without weakening a money guard, and that is not on the table. So the money does not come from there.

## The settlement

The event's books are sealed and correct as sealed, so this is the house paying a ruling outside them. Exactly the parts of `20260926085132` (the mystery-bounty make-good) and `20261002082429` (the PKO unclaimed bounty), with the union-bank bank of `20260926131530`, because Midway Union is the house here: it hosted both satellites (`tournaments.club_id`) and took their 2.00 fee each (`rake_records.club_id`), while SHARK CLUB hosted neither and took no rake from them.

Per satellite, in one transaction:

1. `fn_ca_adjustment_under_10_9` records the approved `ca_manual_adjustments` row with its paragraph.
2. `fn_ca_declare_ledger` names the bank, `union_bank` / Midway Union, and stands the `union_wallets` autoledger down, so the `club_members` journal writes ONE leg `union_bank` to `player_wallet`, club SHARK CLUB, `tournament_id` NULL.
3. The union bank is debited 30.00, refusing if it cannot cover it.
4. `fn_credit_and_log` credits WASP under the key `satellite-seat-cash:<satellite>:<WASP>`, so a replay pays nothing. The key does not begin `tourney:`, so the credit resolves WASP's home club, SHARK CLUB, which is the club both buy-ins came from.
5. The adjustment is settled.

Then the four alerts close carrying the adjustment ids, keys, journal legs and wallet receipts. No obligation, payout row, award row, `tourney:` key, wallet row or journal leg names either satellite, and the post-image proves it by every witness the satellite guard reads.

WASP is a horse fleet player, paid exactly as a human is (CLAUDE.md 10.5). There is no `is_horse` condition in this migration. Nothing is taken back from anyone.

## What stays, and why nothing is tidied

Each satellite keeps the 30.00 of collected pool it never disbursed: 40.00 in, 8.00 to the runner-up, 2.00 fee, 30.00 retained. That is a true, permanent fact about a sealed event, and the migration asserts it rather than clearing it. Total chip supply is unchanged by the transaction: the union bank falls 60.00 and a player wallet rises 60.00.

No `tournament_conservation_baseline` row is written, deliberately. A baseline amount is ADDED by `fn_tournament_conservation_delta`, which reads 0.00 for both satellites today; a -30.00 acknowledgement would silence `fn_satellite_conservation_audit` by breaking the delta, which is the exact failure `tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts` exists to prevent. The satellite audit also only reads satellites that ended inside its window (FeeReconciler passes 24 hours), which is why it has filed nothing for these two since 2026-09-04 21:00: closing these alerts leaves no net firing, and resolving them is not hiding a live finding.

## Proof

Probed as one self-aborting `DO` block over the Supabase MCP with `ca.seat_cash_probe = 'on'` (one call, one transaction, `RAISE EXCEPTION` at the end, so the error is the success case), then re-read to confirm the rollback left no key, no leg, no adjustment and all four alerts open:

```
ERROR: P0001: PROBE OK (rolled back): WASP 68786.36 -> 68846.36,
Midway Union bank 40821.13 -> 40761.13; receipts [...]
```

The migration asserts its pre-image (the bought seat, the four alerts open, each satellite still a COMPLETED 19.00 + 1.00 Midway Union satellite with 40.00 in and 10.00 out and its 2.00 fee, no committed receipt, no prior credit or adjustment under either key, WASP resolving to SHARK CLUB, the bank able to cover 60.00) and the guard itself being armed, so it refuses rather than runs if the reasoning above stops describing the database. It asserts its post-image: the wallet +60.00, the bank -60.00, exactly two legs `union_bank` to `player_wallet` of 30.00 each, exactly two legs touching WASP, no second leg on the union wallet, no row naming either satellite, each satellite's liability still 30.00 and each conservation delta still 0.00.

Pinned by `tests/a-seat-already-bought-is-paid-in-cash-for-two-satellites.law.test.ts`, which now pins the corrected door, that no guard is weakened, that no conservation baseline is written, and that the superseded file carries its never-run notice.
