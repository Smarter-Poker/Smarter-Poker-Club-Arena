# A late status flip never rewrites a paid ladder

2026-09-11 · database (`20260911110000`), not yet applied to production

## What happened

`zz_ca_fund_overlay_on_lock` fires on every ANNOUNCED/REGISTERING ->
RUNNING/COMPLETING/COMPLETED transition. Its first block replaces
`payout_structure` with `fn_ca_payout_structure(entrants, payout_percent)`
whenever the stored ladder has a different number of places. It was written as
a start-time fit and assumed the first status write it sees is the start.

Breakfast Turbo (`c1f15c30`, 40 entrants, 180.00 pool) shows what happens when
it is not:

| UTC 2026-09-08 | Event |
| --- | --- |
| 14:01:23 | `RUNNING flip FAILED after 3 attempts` (refused by `TOURNAMENT_LAUNCH_RECEIPT_REQUIRED`); the game was dealt with its row still REGISTERING |
| 14:24:55 | entry closed; the engine fitted a six-place ladder, 32.53/23.42/16.86/12.14/8.74/6.31 (contract v3) |
| 14:35:24-14:36:41 | places 6 to 2 paid against that ladder |
| 14:53:50 | the played-but-registering sweep relabelled REGISTERING -> COMPLETING; this trigger computed ceil(40 x 10%) = 4 places and wrote 43.12/24.76/17.90/14.22 over the six-place ladder (contract v4) |
| 14:53:51 | first place priced at 77.62 against an escrow holding 58.55; 58.55 paid |

Since then `fn_settle_tournament_places` has refused the event every one to two
minutes ("has a place obligation outside its derived ladder"): obligations 5 and
6 lie outside the four-place ladder. `zzzz_freeze_finalized_tournament_prize_pool`,
which refuses any `payout_structure` change once the pool is finalized, is still
disabled (Stage A), so nothing stopped the write.

## The fix

The payout-table block now runs only while the pool is not finalized and no
place has been paid or owed (`tournament_payouts` / `tournament_obligations`).
After finalization the entry-close door owns the final field's ladder; after
the first obligation the ladder is the contract that money was priced against.
The overlay block, the Spin exclusion and the start-time fit are unchanged. The
function is replaced only if it is still the `20260907220945` definition
(md5 `a18b13b7...`), and re-applying is a no-op.

Measured against production on 2026-09-11: of the non-Spin events paid since
2026-09-01, `c1f15c30` is the only one whose ladder was revised after its first
payout. Completing that event is a separate, one-off ruling; this migration does
not touch it.

## Verified

Local PostgreSQL 17 copy of the production schema with `c1f15c30`'s rows:

- the 14:53:50 relabel (REGISTERING -> COMPLETING, pool finalized, six places
  paid) rewrites the ladder to four places before the fix (md5 identical to
  production's contract v4) and leaves the six-place ladder in place after it;
- a genuine start (REGISTERING -> RUNNING through the atomic launch marker,
  pool not finalized, nothing owed) still refits a nine-place preset to
  `fn_ca_payout_structure(40, 10)`, before and after;
- a fresh apply and a re-apply both leave the function at md5 `bb132bf0...`.
