# 2026-10-24 - The Total Prize Pool is everything put in; Ranking and Entries say who rebought

## Dan's rulings, verbatim

> "REWARDS PAGE SHOULD HAVE THE TOTAL PRIZE POOL INSIDE OF IT. THE TOTAL OF ALL
> THE BUY IN'S REBUYS AND ADD ON'S."

> "AND INSIDE THE RANKING IT SHOULD TELL YOU HOW MANY TIMES THE REBOUGHT AND IF
> THEY ADDED ON AS WELL. THAT SHOULD BE IN THE RANKING AND INSIDE THE ENTRIES"

## What was wrong

**Rewards.** The "Total Prize Pool" tile printed `tournaments.prize_pool` alone.
`fn_ca_process_tournament_chip_purchase_money_v1` splits every purchase, net of
the fee, between `prize_pool` (places) and `bounty_pool` (heads), so on a bounty
event the headline was only the place half. Friday Fight Night PKO (827A1B52),
read from production:

| Line      | Count | Into the pool each | Total      |
| --------- | ----- | ------------------ | ---------- |
| Buy-ins   | 276   | 27 (30 less 3 fee) | 7,452      |
| Rebuys    | 9     | 27 (30 less 3 fee) | 243        |
| Add-ons   | 221   | 30 (no fee)        | 6,630      |
| **Total** |       |                    | **14,325** |

`prize_pool` 10,050 + `bounty_pool` 4,275 = 14,325 exactly; fees 285 x 3 = 855
= `total_rake`. The tile read 10,050.

**Ranking** never showed rebuys or add-ons although every row it renders
already carried `rebuys` and `add_ons`. **Entries** showed them as the
abbreviations "RB 1" and "AO".

## What changed

- `RewardsTab.tsx`: the headline is place pool (with any guarantee overlay)
  plus the bounty pool. A "Where It Comes From" strip lists buy-ins, rebuys and
  add-ons with count x per-purchase amount and line totals, any club overlay,
  and on a bounty event the Place Prizes / Bounty Pool split, so the payout
  ladder below (which divides the place pool) still reads correctly. Amounts
  are priced by the server's rule and printed only when they reconcile with
  the server's pool to the cent per purchase; otherwise the counts show and
  the amounts read "-" (free seats, satellite winners) rather than a guess.
- New `BuyInMarks.tsx`: "1 Rebuy" / "3 Rebuys" and "Add-On" badges in words.
  Ranking prints them beside the table line; Entries replaces RB / AO with
  them. One component, so the two tabs cannot drift.

## Pinned by

`tests/unit/theTotalPrizePoolIsEverythingPutIn.test.tsx` - the 827A1B52
numbers, the breakdown, the non-reconciling case, and both tabs' marks.
