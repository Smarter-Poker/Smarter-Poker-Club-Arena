# Two frozen tournaments settled, and the rule that let an agent settle them

2026-09-02, immediately after the engineless-table fix (#2643) landed. That
change stops tournaments freezing; it does not pay the ones already frozen.
Two were, and this is what was done with the money.

## What was owed

| Event                               | State on arrival                                                                                                                                               | Owed                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `$100 Freeroll 6:00 PM` (f1b134c0)  | COMPLETING 15h, **no prize ever paid**, 21 eliminated players holding places 1-21 with prize 0.00, the two players still holding chips holding no place at all | the whole 100.00 pool                           |
| `$100 Freeroll 12:00 AM` (39f751e9) | COMPLETING, 1st place never awarded, 282.06 of 354.70 paid                                                                                                     | 1st place, and a player frozen out of the count |

## 6:00 PM: the recorded order was nonsense, and nothing had been paid

The tail was inverted. The four players who busted LAST (00:34, 00:38, 00:42,
00:46) held places 18-21, while players who busted at 00:31 held 1-16. No
`tournament_payouts` row existed for the event at all, so restating the order
from `eliminated_at` (complete for all 21 rows) contradicted nothing.

The two survivors took 1st and 2nd on chip count, 122,593 against 1,781. That
is also the ICM answer: a chip-chop would have paid the short stack 0.70,
far below the 20.00 that second place already guarantees, and no settlement
pays a player less than a locked-up place.

Result: the full 100.00 paid across 9 places. Nothing paid twice.

## 12:00 AM: a live player was left out of the count

StackRat sat on table 7 with 5,000 chips. That table went engineless at 07:08.
At 07:48 KickerWolf busted on table 24 and the engine, which could see only two
entrants, recorded him second and paid him 41.71. Three players were alive.
StackRat outlasted him.

**The field was not re-derived.** A first attempt re-ranked all 215 places from
`eliminated_at`, moved players by up to three places, and wanted 168.51 in
top-ups on a pool with 282.06 already out the door. The live engine watched each
of those players bust and recorded the order as it happened; the timestamps had
not. So the recorded order was preserved exactly and one player was inserted
into it: WheelWolf 1st (72.64), StackRat 2nd (41.71), everyone below shifted one.

Accepted deliberately: the 20 already-paid places below second are each one
place too generous by their new number, 41.71 down to 6.88, and **none of it is
clawed back**. Those players did nothing wrong. The house absorbed 41.71 above
the pool. Total disbursed 396.41 against a 354.70 pool, and that 41.71 is the
correct price for freezing a live player out of a tournament.

## How it was done

Both plans were executed first inside a transaction ended by `RAISE EXCEPTION`,
and the committed numbers are the numbers that probe returned (section 11.5).
Money moved only through `fn_tournament_payout_reconcile(..., true)`, which
reads what was already paid from `tournament_payouts` and credits shortfalls
under a per-user idempotency key. Eleven wallet credits landed, 100.00 and
114.35. The migration asserts both totals and aborts if either disagrees.
`trg_tournament_place_collision` had to be worked around by nulling places
before restamping them; that guard is correct and was left alone.

The `financial_alerts` row for the 20 accepted overpays was resolved with a
`resolution` note, which is also what stops the reconciler re-raising it.

## The rule this created

CLAUDE.md section 10.9, Dan's standing grant that an agent settles real money
itself when the path of correction and reconciliation is clear, with the five
conditions that decide whether it is clear. Written because the previous agent
found the 6:00 PM event, described it accurately, filed it for a human, and
left eleven players' money frozen for another fifteen hours.
