# River aggression has a win side (2026-09-01)

## The number that could not be acted on

`river_aggr_lost` was the largest single line in the 2026-08-31 audit: 1,545
hands, -97,229bb -- roughly five times the entire day's horse net of
-19,984bb -- and it dominated the tag mix of nine of the ten bleeding horses.

It could not be acted on, because it has no denominator.

`detectLeaks` returns early on any winning hand (`if (row.netBB > 0) return`),
which is correct for leak tags: a leak is a verdict that the hand was played
badly, and a hand that won was not. But it means `river_aggr_lost` exists only
on losses. A horse that bets every river and a horse that value-bets perfectly
leave identical evidence, because the 5,277 winning hands stored that day
carried no tag at all.

Capping the river on that figure would have been tuning against a sample
selected for being negative.

## The fix

`river_aggr_won` records the same line -- bet or raised the river, reached
showdown -- on the winning outcome. `river_aggr_won` plus `river_aggr_lost` is
river aggression's actual EV.

It is **not** a leak tag and is named so no gate can mistake it for one. The
self-tuner reads tags by exact name (`nonnut_flush_stackoff`, `big_bet_fold`,
`preflop_stackoff`), so nothing downstream picks it up by accident -- and a
test asserts `HorseSelfTuner.ts` never mentions it, because the failure mode
there is precise and bad: a _profitable_ river would tighten the horse.

`fn_audit_river_aggression_ev` reports both sides in the daily audit, with the
recommendation flipping on the sign:

- net negative -> "now a cap is worth testing: flag it, add a league matchup,
  and do not claim an improvement without significance"
- net positive -> "the large `river_aggr_lost` total is the cost of a winning
  line, not a leak -- do not tighten the river caps on the strength of it"

Until a full day has both sides it emits `river_aggr_ev_one_sided` instead,
which says plainly that the loss total has no denominator yet. Run against
2026-08-31 it does exactly that: _"River aggression has 1545 losing hands
recorded and no winning ones."_ Half a ledger is not reported as a whole one.

## Collateral

`flags a big WIN with no leak tags` asserted an empty tag array. The property
it cares about -- a win carries no LEAK tag -- is unchanged and still pinned;
the assertion was widened to allow the outcome record, in this commit, with
the reason written next to it.

## Verification

`npx tsc --noEmit` clean. Full server suite: 306 files, 3418 tests, 0
failures. Six new tests cover the win tag, the loss tag, a win that trips no
leak tag despite 200bb invested, a win with no river aggression, a win that
never reached showdown, and the self-tuner isolation.
