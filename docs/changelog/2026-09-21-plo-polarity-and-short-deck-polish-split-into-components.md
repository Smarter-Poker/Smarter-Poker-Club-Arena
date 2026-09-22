# PLO polarity and short-deck polish split into components, and where plo_set_stackoff loses

2026-09-21. Audit items P2.2 (second half) and P2.3 from the 2026-09-20 horse
audit (`horse_daily_audit.agent_analysis`): "plo_set_stackoff is worse per hand
at -48.99bb over 276 hands but far rarer", and "Ablate shortdeck_v23 and
plo4_v16_polarity properly before tuning either further."

No strategy moves in this change. Production play is unchanged: the new flags
are ablation controls that default to the current behavior, and a pinned
scenario set proves the default decisions are the pre-split decisions.

## plo_set_stackoff: what it counts

`server/src/services/HorseHandReview.ts` (the V38 PLO stackoff block, the
`flag(boardHasPair(boardAt) ? 'plo_naked_trips_stackoff' : 'plo_set_stackoff')`
line). An Omaha hand that went to showdown on a full board with at least
`PLO_STACKOFF_BB` (100bb) invested, whose commit street (`commitStreet`: hero's
last bet, raise, call or all-in) is postflop, where the hand hero held on the
board as of that street is three of a kind on an unpaired board (a set) and a
full house, flush or straight is live. `plo_set_stackoff` on a loss,
`plo_set_stackoff_won` on a win (the 2026-09-05 mirror). Rows are
`horse_hand_reviews.leak_tags`, rolled up in `horse_review_rollup`. The tag is
not in `PLO_STACKOFF_TAGS` (`HorseLogic.ts`), so no strategy reads it.

Daily, both tags, from `horse_hand_reviews` (`horse_review_rollup` carries the
same counts):

| day (UTC) | lost | won | net bb | bb/hand |
| --------- | ---- | --- | ------ | ------- |
| 09-14     | 25   | 11  | -1,853 | -51.5   |
| 09-15     | 6    | 4   | +554   | +55.4   |
| 09-16     | 15   | 6   | -1,381 | -65.8   |
| 09-17     | 59   | 26  | -4,340 | -51.1   |
| 09-18     | 37   | 25  | -2,243 | -36.2   |
| 09-19     | 23   | 13  | -1,000 | -27.8   |
| 09-20     | 20   | 5   | -3,057 | -122.3  |
| 09-21     | 12   | 8   | -374   | -18.7   |

09-14 to 09-20: 275 hands, -13,320bb, -48.4bb per hand, 33% won (the audit's
276 and -48.99 is a seven-day window one hand wider). Every voluntary action in
those 275 hands is `horse_policy` or `horse_fallback`: this is horse against
horse, so the loss is another horse's win.

By variant: plo4 104 hands, -63.6bb per hand; plo5 102, -22.9; plo6 52, -77.1;
plo8 17, -21.2.

By the street and the kind of hero's last committing action:

| commit street | hero's last action | hands | bb/hand | net bb | won |
| ------------- | ------------------ | ----- | ------- | ------ | --- |
| river         | called             | 80    | -101.2  | -8,097 | 16% |
| turn          | called             | 71    | -34.7   | -2,461 | 39% |
| river         | bet or raised      | 48    | -33.1   | -1,590 | 42% |
| turn          | bet or raised      | 64    | -8.8    | -565   | 39% |
| flop          | any                | 12    | -50.5   | -606   | 33% |

The river call-off is 61% of the loss, and a call always reaches showdown, so
that row is not thinned by fold-outs the way the bet rows are. Priced from each
call's own `publicNode` (pot and price at the decision): the 80 calls faced
about 70% pot on average, needed 27.1% on average, and won 16.3%. Against
folding, the calls themselves cost -1,757bb (-22.0bb per call; a chop is
counted as a loss). On boards where a straight is possible and a flush is not,
60 calls won 15% against 29% needed, -1,763bb. plo4 31 calls (16% won, 26%
needed), plo5 27 (15%, 26%), plo6 19 (21%, 30%), plo8 3.

The layers a set meets on an Omaha river (`HorseLogic.decidePostflop`):

- The V15 equity cap caps only straights and flushes (`cat === 5 || cat === 6`).
- The V20 pressure cap, the V21 dominated cap and the V21 scare-runout cap are
  all `!vi.isOmaha`.
- The V40 Omaha pressure cap is the only cap on a set: `omahaMadeClass`
  (`HorseEval.ts`) marks a set `weak` when a straight or flush is possible, and
  the class ceiling is 0.62, minus 0.05 per heat above one with heat capped at
  four, so never below 0.47 on the river. A pot-sized bet needs 33%, so this
  cap cannot on its own turn a set's river call into a fold.
- The fold or call is the V38 `riverCallVerdict` return at the end of
  `decidePostflop`, on `eqRead38` (the capped equity with the read shift).

Which return each of these 80 calls took is not recorded per hand, so the
layer that made them is inferred from the code, not measured. What is
measured is the outcome: the equity those calls were priced at is well above
what they won. Any change to it (a lower set ceiling on straight-possible
rivers facing a big bet is the obvious candidate) is a calibration, so it
needs a DEFAULT-OFF flag, scenario tests and a league matchup that resolves
before anything is claimed. It is not made here.

## What v16PloPolar and v23Variants gate

`v16PloPolar` is read once, as the `omahaAA` read `HorseLogic.decide` hands to
the preflop engine (`HorsePreflop.decidePreflopV7`). It gates two behaviors:

- `omahaAA === true`: the AAxx 3-bet bar sits 0.04 under the generic bar.
- `omahaAA === false`: a hand without AA inside 0.05 over the bar flats when
  the price is at most 8% of the stack.

Both reach every Omaha variant (`vi.isOmaha`); they were measured moving
decisions in plo4, plo5 and plo8 deals. The league measures them in plo4.

`v23Variants` is read once, in `decidePostflop`. It gates three behaviors:

- short deck: the one-pair (`cat === 2`) thin-value bar is 0.03 higher.
- short deck: a live draw's implied-odds allowance is 0.04 + 0.02.
- hi-lo: a low-only draw (hi under 0.15, lo over 0.3) gets no implied credit,
  0.03 more on the sizing penalty of the heuristic call line and 0.03 off the
  V38 call equity.

A short-deck deal reaches the first two; the third needs a hi-lo deal, so
`plo8_v23_lowdraw` already measures it alone and needs no sub-flag.

## What changed

- `HorseDecideOpts` gains four ablation flags, each declared right after its
  master and each defaulting to the current behavior: `v16PloPolarAA3Bet`,
  `v16PloPolarFlat` (after `v16PloPolar`), `v23SdThinValue`, `v23SdDrawCredit`
  (after `v23Variants`). The master still turns every component off.
- `ploPolarityRead` (exported from `HorseLogic.ts`) replaces the inline
  `omahaAA` expression. With default flags it is that expression exactly.
- `HorseDataLedger.ts` registers the four flags.
- `LEAGUE_MATCHUPS` gains `plo4_v16_polarity_flat` right after
  `plo4_v16_polarity`, and `shortdeck_v23_thin_value` and
  `shortdeck_v23_draw_credit` right after `shortdeck_v23`. The parents are
  unchanged, so their history stays comparable.

Each new matchup was checked with a throwaway `runMatchup(matchup, 1000, seed)`
before it went on the card (deleted before commit). bb/100 at 1,000 pairs is
not an edge measurement and none is claimed:

| matchup                         | divergent pairs, seed 4242 | divergent pairs, seed 20260921 | on the card |
| ------------------------------- | -------------------------- | ------------------------------ | ----------- |
| plo4_v16_polarity (parent)      | 13                         | 12                             | already     |
| b: { v16PloPolarFlat: false }   | 12                         | 12                             | yes         |
| b: { v16PloPolarAA3Bet: false } | 1                          | 0                              | no, inert   |
| shortdeck_v23 (parent)          | 28                         | 33                             | already     |
| b: { v23SdThinValue: false }    | 15                         | 10                             | yes         |
| b: { v23SdDrawCredit: false }   | 21                         | 30                             | yes         |

The AAxx discount changed the result of 1 of the 2,000 pairs across both
seeds, so it has no matchup. Because it almost never fires,
`plo4_v16_polarity_flat` should read close to its parent night to night (12
divergent pairs and an identical result at 20260921); it gives the flat a
history under its own name before anything about it is tuned.

## League history (horse_league_results)

Inverse-variance pooled; a night is significant at |bb100 / stderr| >= 1.96.
Negative means production (the layer on) trails the layer off.

| matchup           | window         | runs | pooled bb/100 | stderr | z     | significant nights    |
| ----------------- | -------------- | ---- | ------------- | ------ | ----- | --------------------- |
| plo4_v16_polarity | 09-14 to 09-21 | 8    | -0.71         | 0.35   | -2.02 | none                  |
| plo4_v16_polarity | 08-31 to 09-21 | 17   | -0.28         | 0.25   | -1.12 | one positive, 09-08   |
| shortdeck_v23     | 09-14 to 09-21 | 8    | -0.79         | 0.32   | -2.46 | negative 09-16        |
| shortdeck_v23     | 08-28 to 09-21 | 19   | -0.40         | 0.17   | -2.36 | negative 09-04, 09-16 |
| plo8_v23_lowdraw  | 09-14 to 09-21 | 8    | +1.45         | 0.24   | +6.01 | five positive         |
| plo8_v23_lowdraw  | 08-31 to 09-21 | 17   | +1.61         | 0.17   | +9.41 | eleven positive       |

## Production play unchanged

Decision streams, all six seats on one config, league deals with fixed seeds,
computed on origin/main 397a467976 (before the split) and on this branch:

| variant    | hands | `{}`      | master off |
| ---------- | ----- | --------- | ---------- |
| plo4       | 400   | identical | identical  |
| plo5       | 200   | identical | identical  |
| short_deck | 2,000 | identical | identical  |
| plo8       | 400   | identical | identical  |

`server/src/engine/HorseComponentFlags.test.ts` pins the pre-split decisions
of a fixed scenario set (the first hands of each variant plus the hands where
each component was measured to move a decision) for `{}` and for each
parent's b-side, and checks that each component reaches its own path, that
the master off is exactly every component off, and that no component reaches
a variant it is not written for.

`cd server && npx tsc --noEmit` passes; `npx vitest run` passes except the 16
Linux-only tests in `src/benchmark/HorseLeagueProcessPriority*.test.ts` on
macOS.
