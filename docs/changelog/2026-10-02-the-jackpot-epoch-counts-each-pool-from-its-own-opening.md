# 2026-10-02 - The jackpot epoch counts each pool from its own opening

Incident `f3e82f59` (`fn_ca_conservation_sweep:fn_bbj_conservation_check`,
11 occurrences from 02:52 UTC) reported the BBJ epoch short:
`moved_since_recorded -4,400.00`, `unexplained_since_opening -4,409.82` at
12:52, and -4,600.00 / -4,609.82 by 13:42.

## What the 4,409.82 was, by transaction

No chip is missing and no jackpot is unpaid. The figure was two things:

- **-4,400.00 (later -4,600.00): 46 welcome-package pool seeds counted
  twice.** Since `20261001154709` / `20261002010726` the lifetime-first club
  welcome package creates each new club's `bbj_pools` row with
  `main_balance 100.00` from the club treasury, and the autoledger writes the
  matching `chip_ledger` leg (`opening_setup -> bbj_pool`,
  `club_opening_allocation`) in the same transaction, so the leg's
  `created_at` equals the pool's `created_at`. The first was pool `a040f599`
  at 01:38:36; the 46th, `a6dfd164`, at 13:26:55. `fn_bbj_open_pool_baseline`
  opens such a pool at `taken_at = GREATEST(created_at, epoch)` and
  reconstructs the opening balance as banks minus the journal **strictly after**
  `taken_at`, so each baseline reads 100.00 (the seed is in it).
  `fn_bbj_conservation_check` then summed the baselines and the journal since
  the one global epoch (2026-09-04 21:17:14), which also includes the seed:
  `current - 100 - (100 + drops) = -100` per pool. The figure stepped by 100
  every time the hourly meter opened another pool's baseline. Per pool from
  its own opening, all 46 read 0.00.
- **-9.82: the residue recorded on 2026-09-09**, club pool `a7a65cfc` -5.88
  and union pool `f9806a7f` -3.94, unchanged to the cent since and excluded
  from the verdict as `known_residue`. Not new and not touched here.

The lifetime half of the check had the mirror image: the 46 seeds are 4,600.00
of balance with no `bbj_contributions` row, and 26 of those certificate-club
pools were later retired by journalled burns to `chip_retirement` (2,600.00
with no outflow term), so `lifetime.moved_since_resolution` read -2,000.00.

## The root-cause line and the fix

The defect was the check's epoch window: one global `l.created_at > v_epoch_at`
against per-pool baselines that are each taken at the pool's own opening.
Migration `20261002135140_the_jackpot_epoch_counts_each_pool_from_its_own_opening`
rewrites only `fn_bbj_conservation_check` (by text replacement of the reviewed
pre-image, md5 `cd515fb2...`):

1. a pool opened after the epoch is measured from its own opening - the legs
   between the epoch and its `taken_at` are added back
   (`epoch.absorbed_by_later_openings`);
2. a later pool's journalled seeds (`club_opening_allocation`) and burns
   (`burn`) enter the lifetime identity
   (`lifetime.journalled_seeds_after_epoch`, `journalled_burns_after_epoch`).
   An ORIGINAL pool is still measured from the epoch, so a seed or burn there
   stays loud.

The writer (welcome allocator + autoledger) was correct: balance and ledger leg
in the same transaction. `fn_bbj_open_pool_baseline` was internally consistent
with `fn_bbj_reconcile`. Neither is changed. Extra cost: one indexed read per
later-opened pool, 46 ms for 46 pools.

## Settlement (CLAUDE.md 10.9)

None owed, and nothing moved. Every one of the 4,600.00 is a club-treasury seed
into that club's own new pool with its ledger leg; 2,600.00 of it was later
retired by journalled burns. No player is short, `paid_without_a_payout_row_since`
is 0.00, and the last `bbj_payouts` row (08:03) is unaffected. Horses and humans
alike: no player was a party to any of these movements.

## Proof

Read-only probe (one `DO` block, compiled into `pg_temp`, ended by
`RAISE EXCEPTION`): `healthy=true`, `epoch.moved_since_recorded 0.00`,
`unexplained_since_opening -9.82`, `absorbed_by_later_openings 4600.00`;
`lifetime_healthy=true`, `lifetime.moved_since_resolution 0.00`,
`unexplained 45.80`, seeds 4,600.00, burns 2,600.00. The migration re-asserts
these at apply time and aborts if they do not hold.

Pinned by `tests/the-jackpot-epoch-counts-each-pool-from-its-own-opening.law.test.ts`.

## Note for PR #5730

Its recording migration `20261001152917` guards the installed
`fn_bbj_conservation_check` body at md5 `cd515fb2...`; after this lands the
pre-image is the new body and that guard (and its fixture) needs re-pinning.

## Follow-up: a pool the meter has not opened yet (20261002145612)

After `20261002135140` was applied (14:46 UTC, recorded statements md5
`03462418...` = the file on main), the epoch read healthy (`moved_since_recorded
0.00`) but `lifetime.moved_since_resolution` read -100.00: pool `2032add6`,
created 14:42:20 with its 100.00 welcome seed, had no meter baseline yet, so the
lifetime set (found through baselines) missed its seed. `20261002145612` finds
later pools by `COALESCE(baseline, created_at) > epoch` and only lets a pool
WITH a baseline give legs back to the epoch residue, so the epoch figure is
identical. Probe: both verdicts healthy, lifetime moved 0.00, seeds 5,400.00,
burns 5,200.00.
