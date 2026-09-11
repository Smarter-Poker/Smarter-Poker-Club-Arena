# The PLO stack-off tags read the commit street

2026-09-11 (daily horse audit analysis for 2026-09-10)

## What was wrong

The V38 PLO stack-off detectors in `server/src/services/HorseHandReview.ts`
(`plo_naked_trips_stackoff`, `plo_set_stackoff`, `plo_underfull_stackoff`,
`plo_toppair_no_redraw_stackoff`) judged every hand on the five-card river
board, whichever street the stack actually went in on. That labels the decision
by how the hand ENDED, not by what the horse held when it committed.

Measured over the seven days to 2026-09-10, classifying each tagged review by
the hero's last chip-committing action:

| tag                            | preflop | flop | turn | river |
| ------------------------------ | ------- | ---- | ---- | ----- |
| plo_toppair_no_redraw_stackoff | 64      | 55   | 112  | 122   |
| plo_naked_trips_stackoff       | 10      | 61   | 176  | 307   |
| plo_underfull_stackoff         | 5       | 54   | 317  | 557   |

The 64 preflop "top pair, no redraw" rows are AA/KK 4-bet and 5-bet wars
(reviews 411733 AA76, 430475 AAJJ, 388442 AAKK33, 374544 AAQJJ4) that showed
down an unimproved pair. Review 376230 was tagged naked trips for a FLOP
stack-off holding aces and the nut flush draw on Q-3-3; the board merely ran
out 5-5. The same shape is why the tag's "12% win rate" cannot be read as a
decision error: an AA all-in that loses stays one pair, one that wins usually
improves, so the loss side of the mirror is selected for not improving.

It matters beyond the panel: `HorseLogic.ts` reads these tags into
`ploStackoffLoad`, which lowers the V40 Omaha pressure ceiling for a horse the
tagger keeps catching. A horse playing aces correctly preflop was having its
postflop ceiling lowered for it.

## What changed

- `commitStreet(heroActions, invested)` returns the stage of the hero's last
  action that put chips in (bet, raise, call, any all_in). A trailing CALL of
  less than 15% of everything the hero invested is a remainder, not a decision
  (411733: 104.55 called off preflop, then 22.28 more when the villain shoved
  his last chips on the flop). Unknown actions return null.
- `boardAsOf(board, street)` is the board the hero could see on that street.
- The V38 block judges the made hand on that board. A preflop commit stands the
  block down entirely: `preflop_stackoff` owns it, and that tag now also fires
  when the only postflop action was a remainder call.
- A flop or turn commit with at most one pair is tagged
  `plo_toppair_no_redraw_stackoff` only when `omahaDrawQuality` finds no flush
  draw and fewer than eight straight outs - on those streets the redraw is
  still live, and "no redraw" has to mean it.
- Rows with no readable actions keep the river-board judgement, so every
  fixture already pinned in `HorsePloStackoffDetectors.test.ts` and
  `HorseLeakDetectorsCallOffAndPloBoats.test.ts` is unchanged.

Tests: `server/src/services/HorsePloStackoffCommitStreet.test.ts` - the real
hands above are the fixtures (411733, 376230, 406071, 393394), plus the
remainder rule and the null-actions fallback.

## What did not change

No strategy dial moved. The ~480 naked-trips stack-offs a week that commit on
the turn or river are real (read ten, nine genuine) and are recorded in the
2026-09-10 audit analysis as a V40 `weaktrips` ceiling question, which is a
flag-plus-league change, not a detector change.
