# Phase 8: the other currencies get their guards and a meter

2026-09-08, 02:05-03:10 UTC. Phase 8 of 9 of the chip-accounting programme
(`docs/CHIP-ACCOUNTING-ROADMAP.md` 9.7), opened on Dan's "PROCEED TO PHASE 8
OF 9" after the phase 7 deep dive (#3626) landed and published. Everything
below was read from production before anything was written.

TWO migrations, both applied and proved in-transaction, both byte-identical
to the recorded statements:

- `20260908030358_the_other_currencies_get_a_meter` (no table lock)
- `20260908030657_the_other_currencies_get_their_guards` (locks, held briefly)

Why two is the interesting part; see "Why it had to be split" below. Branch
`fix/phase-8-the-other-currencies`.

## What the roadmap said, and what was there

9.7 says VIP points, rakeback and agent commissions "have no journal, no meter
and no conservation check". Read on the 8th, two of the three DO have a
journal, and the roadmap's real point stands for all three: nothing guards
the journal, nothing guards the balance, and nothing would say so the morning
an identity stopped holding.

| currency          | balance                                                          | journal                                                                                        | identity today                                                                                                                                                                                                                                                       | guards before phase 8                                                                                                                     |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| VIP points        | `vip_points`, 1,005 rows, 139,913,995 outstanding                | `vip_points_ledger`, 5.75M legs, ~306k/day                                                     | 1,005 of 1,005 balances = sum of legs; 1,005 of 1,005 lifetimes = sum of positive legs                                                                                                                                                                               | none on either table; the award writer inserted the leg with `points = 0` and UPDATED it afterwards (1.69M updates against 1.69M inserts) |
| agent commissions | `agent_commission_unsettled_rollup`, 239 rows, 1,005,462.14 owed | `agent_commissions`, 3.96M rows                                                                | 239 of 239 rollups = sum of unsettled rows                                                                                                                                                                                                                           | rollup kept by statement triggers; rows unguarded (anon/authenticated hold write grants, RLS refuses them; service_role can do anything)  |
| rakeback          | `rakeback_periods` (accrues during the period by design)         | `rakeback_period_payouts` + `chip_ledger` `rakeback` legs (journaled by another lane on 09-07) | **three totals**: periods paid 329,180.89 over 3,357; payout rows 285,190.25 over 2,704; chip legs to players 231,046.71 since 09-07. 653 paid periods have no payout row; every payout row's `wallet_transaction_id` is NULL. 310,136.10 pending over 2,763 periods | none                                                                                                                                      |

Also read: Club Arena's `AdminDashboardPage` "pay" button DELETEs
`agent_commissions` rows from the browser to mark them paid. RLS matches no
row, PostgREST returns no error, the operator is told it worked. `n_tup_del`
on that table is 1, ever.

## What was built - the guards are the fix, the meter is the proof

**1. Three more journals are append-only** under the guard `chip_ledger`
already has, `fn_ca_journal_append_only`, which learned each table's one
legitimate movement: nothing on `vip_points_ledger`; `settled_at` from NULL
to a time, once, on `agent_commissions`; only the payout's own bookkeeping
(`status`, `paid_at`, `wallet_transaction_id`, `failure_reason`) on
`rakeback_period_payouts`. DELETE is refused outside the sanctioned
maintenance path - except on `rakeback_period_payouts`, where
`fn_close_settlement_period` inserts the payout row as its idempotency claim
BEFORE debiting the treasury and deletes it again on a shortfall, inside one
transaction. That is a compensation, so it is allowed and **recorded**, every
time, in `ca_ledger_mutation_log`; the meter counts them.

**2. `vip_points` moves only with a leg.** `zz_vip_points_move_only_with_a_leg`
refuses any change to `current_points` or `lifetime_points` unless the writer
has declared itself for this transaction (`app.vip_points_writer`), refuses a
negative balance and a shrinking lifetime outright. Both writers
(`fn_award_vip_credit`, `fn_redeem_vip_points`) declare themselves around
their one balance write. Measured before attaching: 0 negative balances, 0
lifetimes below current.

**3. `fn_award_vip_credit` writes the leg once, final.** The carry row is
locked first, the points computed, the leg inserted with the number it will
always carry. Same idempotency key, same rounding, same answer; one write
instead of two, and a guard that forbids updates can now sit on the table.

**4. `ca_currency_meter` + `fn_ca_currency_meter()`.** One row per currency
per night: outstanding liability, journal total, accounts compared, accounts
drifted, worst drift, `enforced`, and a detail block. VIP and commission drift
is a CRITICAL incident - the guards now make those identities hold by
construction, so seeing one means a guard was bypassed or dropped. Rakeback
is `enforced = false`: the row carries the three totals side by side, the
orphan count and the day's compensating deletes, and raises a WARNING with
the numbers, because that path is another lane's live rebuild (six
migrations on 09-07 between 19:03 and 19:31) and the disagreement predates
this phase. It rides `ca-ledger-replay-nightly` (job 286, 06:40 UTC, 600 s
statement timeout); no new scheduled job.

## Proved in the migrations, all rolled back

A cold VIP leg edited and deleted (refused); a cold VIP balance moved with no
leg, moved negative (refused); the award writer end to end on a cold account -
one leg, final, balance moved by exactly it, a second award for the same
source writes nothing - then rolled back and asserted gone; a commission
amount edited and a row deleted (refused), a settlement un-settled (refused);
a payout amount edited (refused), a payout deleted (allowed, recorded, rolled
back); the meter run, one row per currency written, VIP and commissions at zero
drift; the nightly job carrying both the replay and the meter; every new
function's grants read from the catalogue.

The meter's first reading, live at 03:03:58:

| currency          | outstanding        | journal              | accounts | drifted | enforced |
| ----------------- | ------------------ | -------------------- | -------- | ------- | -------- |
| vip_points        | 139,923,683        | 139,923,683          | 1,005    | 0       | yes      |
| agent_commissions | 1,010,294.87       | 1,010,294.87         | 239      | 0       | yes      |
| rakeback          | 312,144.11 pending | 285,190.25 paid rows | -        | 1       | no       |

## Why it had to be split, and what that taught

The first shape was one migration, and it could not be applied. Three attempts,
each one a measurement:

1. **02:19, deadlock (40P01).** `CREATE TRIGGER` takes ACCESS EXCLUSIVE, and
   taking it after other locks raced an in-flight award. Fixed by taking every
   altered table's lock up front, in one statement, with a `lock_timeout`.
2. **02:55, lock timeout, with the platform frozen.** The hourly freeze guards
   seven money and seat tables; `vip_points_ledger` is not one of them, so VIP
   awards keep landing right through it. The freeze does not quiet this table.
3. **The real problem, which the timeout was hiding.** The proof inside that
   transaction runs the meter, and the meter's VIP pass scans 5.75M legs -
   10.2 s measured. Holding ACCESS EXCLUSIVE for ten seconds against an engine
   whose `service_role` carries an 8 s `statement_timeout` would not have
   slowed VIP awards, it would have FAILED them. A failed award is points a
   player earned and did not get.

So the work is two migrations. Part one has no table lock at all - its
ten-second proof runs under ACCESS SHARE and blocks nobody - and it rewrites
the award writer into the one-insert shape a guard can sit on. Part two takes
the locks and holds them for the length of five refusals, all sub-second.
Neither needed the freeze in the end; both were applied with the platform
live, at 03:03 and 03:06.

## Growth, stated

The meter's VIP pass is O(journal): 10.2 s at 5.75M legs, growing ~306k legs a
day, so it crosses the job's 600 s timeout in roughly five years. It is the
same class of cost phase 6's verifier had, and the same fix applies when it is
needed (a rotation over a `created_at` index, which `vip_points_ledger` does
not yet have). Written down here so nobody is surprised.

## For a decision - not done here

- **Rakeback's payout path** inserts the payout as `paid` before the money
  moves and links no `wallet_transaction_id`; 653 paid periods have no payout
  row and the three totals disagree by 44k / 98k. The meter names it nightly.
  Fixing it means touching `fn_close_settlement_period`, rewritten by another
  lane on 09-07.
- **The AdminDashboardPage "pay" button** that deletes commission rows from
  the browser and reports success. With the guard it would now be refused if
  it ever reached the row; it never has.
- **`vip_points_ledger` has no `created_at` index**; the meter's rotation,
  when the journal needs one.

## Still open, carried

Unchanged: 364.80 owed to three tournament winners pending Dan's
bubble-protection decision; the unbanked raked hand (`56d12749`, 7.50);
idempotency keys on 0.08% of legs; partition cut stages 2-5; the thirteen
uncalled World Hub money routes; the legacy World Hub poker engine; the RG
self-exclusion route's parameter names.
