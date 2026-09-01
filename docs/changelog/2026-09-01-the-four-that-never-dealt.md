# The four that never dealt

`fn_detect_results_without_a_hand` raised four criticals at 12:20 UTC. Each
names a tournament that ranked its whole field and, in two cases, paid real
chips, without a single hand ever being dealt in it.

| event                          | date  | entrants |   paid | ran for |
| ------------------------------ | ----- | -------: | -----: | ------: |
| Friday Six-Card Nightcap       | 08-29 |       24 | 216.00 |    216s |
| Sunday Deep Stack Satellite $5 | 08-28 |       24 | 108.00 |     84s |
| $100 Freeroll 6:00 PM          | 08-30 |      313 |   0.00 |     58s |
| $100 Freeroll 12:00 PM         | 08-30 |      326 |   0.00 |     89s |

## What caused it

The retired legacy engine in the World Hub process. `_recoverTables` claimed
the 100 most recently created open tables with no tournament filter,
`_saveAllSnapshots` stomped their status every 30 seconds, and
`_cleanupStaleTables` closed each one after ten minutes as "stale and empty" —
empty being true only of the legacy in-memory `Table` object, which never held
the real players. `trg_on_table_status_change` then released the seats and the
deal loop parked in `idle_not_enough_players`.

`20260830180715_a_table_close_cannot_unseat_a_live_tournament` stopped the
unseating at 18:07 UTC on 08-30 and `20260830181001` reseated the fields that
had already been dropped.

## How big it actually is

A first pass over 14 days found ~15,650 events and 1.16M chips, which was
wrong and worth recording as a caution. `hand_history` is pruned for horse-only
hands after seven days, so before that boundary the absence of a hand proves
nothing at all — and the population there is dominated by Spins and Heads-Up,
which are horse-only by nature.

Measured the way the detector measures it — `hand_history.tournament_id`, and
only inside the six days the retention policy makes trustworthy — the
population is **exactly these four**, and there has been none since
2026-08-30 23:01 UTC.

## Dan's ruling, and what moved

> Refund the buy-ins.

Treat all four as never having happened. Three legs, and nothing minted:

| leg            | direction                          | amount | rows |
| -------------- | ---------------------------------- | -----: | ---: |
| prize clawback | `player_wallet -> prize_liability` | 324.00 |   14 |
| fee reversal   | `union_wallet -> prize_liability`  |  36.00 |    2 |
| refunds        | `prize_liability -> player_wallet` | 360.00 |   48 |

324 + 36 = 360, so `prize_liability` nets to exactly zero. Every leg names a
real counterparty, declared through `fn_ca_declare_ledger` before the write, so
**none of it landed in `settlement_suspense`** — verified afterwards: zero new
suspense rows.

All 48 entrants are horses and are refunded identically to a human. There is no
`is_horse` branch anywhere in the migration (CLAUDE.md 10.5).

Wallets were resolved the way the platform resolves them: `fn_credit_and_log`
for the refunds, exactly as `atomic_cancel_tournament` does, and each clawback
debits the club the prize was credited to, confirmed against the `chip_ledger`
rows written at payout time. The smallest balance standing behind a clawback
was 24,543.32 against a 32.40 debit.

## What checked the work

- Probed first inside a `DO` block ending in `RAISE EXCEPTION`, per CLAUDE.md
  11.5. It reported 48/360.00, 14/324.00 and 36.00, and rolled every chip back.
  It also caught two things before they touched production: `'reversal'` is not
  a legal `wallet_transactions.category` (`'prize_reversal'` is), and a global
  before/after balance comparison cannot prove conservation on a live floor —
  other tables move chips while the migration runs. The assertions are on the
  amounts the migration itself moved.
- `trg_tournaments_cancel_must_refund` is the independent check. It refuses to
  let a tournament become `CANCELLED` while any entrant still holds an
  unrefunded buy-in, and it accepted all four.
- No correction row was posted to `chip_ledger`. The movements above are real
  ledger entries; `fn_ca_post_correction` would have added a second, phantom
  one on top of them. The incidents carry the migration name as their
  `correction_ref` instead.

## Still open

`_recoverTables` is a no-op on `main`, but `_saveAllSnapshots` and
`_cleanupStaleTables` are not — both are still live code in the World Hub
process, safe today only because nothing populates the legacy lobby map. The
commit that retires them exists on Dan's Mac
(`agent/cowork-tourney/fix/legacy-engine-unseats-live-fields`) and is 293
commits behind main, so it should be re-cut against current main rather than
pushed as it stands.
