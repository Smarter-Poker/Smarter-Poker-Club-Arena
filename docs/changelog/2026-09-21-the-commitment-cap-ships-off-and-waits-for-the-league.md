# The commitment cap ships off and waits for the league

2026-09-21. Audit item P2.2. The 2026-09-20 horse audit
(`horse_daily_audit.agent_analysis`) called `top_pair_weak_kicker_stackoff`
"the day's real leak, and it is getting worse": "-39.54bb per hand over 1,617
mirrored hands, win rate 26.5 percent ... it spiked to 4.36 per 1k hands
against a 2.77 seven-day baseline, up 57 percent". It asked for a flag,
scenario tests and a league matchup: "Target the commitment threshold for
one-pair and weak-kicker trips at 20bb-plus pots ... and check whether the V15
dominated-hand commitment floor covers trips with a sub-top kicker at all."

This ships `v51CommitCap`, DEFAULT OFF, and the `v51_commitment_cap` matchup.
It claims no improvement. Promotion needs three separate significant-positive
nightly runs (|bb100| > 2 x stderr), the rule `v16Ratio` is held to.

## Where the leak is measured

- `server/src/services/HorseHandReview.ts`, the V24 block: hold'em, shown
  down, a five-card board, 40bb or more invested (2 x `FLAG_BB`), top pair on
  an unpaired top board rank with a kicker of nine or worse that is not on the
  board. The `_won` tag is its mirror.
- Each review adds to `horse_review_rollup` (`leak_counts`, `leak_net_bb`).
  `fn_horse_tag_ev(p_day - 6)` pairs the tag with its mirror, and
  `fn_run_horse_daily_audit` writes the `tag_ev_negative` finding.
  `fn_horse_tag_ev` has no upper bound, so each window runs from `day - 6` to
  the moment the audit ran (06:06 UTC the next day).

The series, as the audit wrote it (`tag_ev_negative`, trailing window):

| audit day | hands | won   | bb/hand | net bb   |
| --------- | ----- | ----- | ------- | -------- |
| 09-10     | 2,483 | 27.4% | -41.04  | -101,891 |
| 09-11     | 2,419 | 31.0% | -35.52  | -85,919  |
| 09-12     | 2,376 | 31.7% | -32.60  | -77,455  |
| 09-13     | 2,165 | 31.5% | -32.88  | -71,177  |
| 09-14     | 1,855 | 30.2% | -33.54  | -62,217  |
| 09-15     | 1,373 | 28.0% | -35.57  | -48,843  |
| 09-16     | 1,203 | 26.0% | -37.59  | -45,226  |
| 09-17     | 1,334 | 25.7% | -38.65  | -51,563  |
| 09-18     | 1,467 | 25.9% | -38.59  | -56,610  |
| 09-19     | 1,541 | 25.8% | -39.89  | -61,474  |
| 09-20     | 1,617 | 26.5% | -39.54  | -63,933  |

Day by day from `horse_review_rollup` (tag plus mirror; the rate is loss tags
per 1,000 reviewed hands, the spike detector's rate):

| day   | hands | won   | bb/hand | loss tags per 1k |
| ----- | ----- | ----- | ------- | ---------------- |
| 09-10 | 288   | 29.5% | -31.72  | 7.14             |
| 09-11 | 268   | 28.7% | -33.32  | 6.94             |
| 09-12 | 200   | 28.5% | -30.17  | 7.89             |
| 09-13 | 83    | 22.9% | -43.54  | 6.66             |
| 09-14 | 164   | 22.0% | -45.11  | 7.95             |
| 09-15 | 89    | 16.9% | -52.12  | 9.05             |
| 09-16 | 77    | 18.2% | -54.65  | 6.12             |
| 09-17 | 308   | 28.6% | -35.28  | 6.60             |
| 09-18 | 448   | 27.0% | -36.02  | 8.27             |
| 09-19 | 317   | 27.1% | -41.65  | 11.76            |
| 09-20 | 170   | 32.4% | -33.39  | 9.11             |
| 09-21 | 128   | 24.2% | -40.79  | 11.22 (partial)  |

One correction. The "4.36 per 1k against 2.77, up 57 percent" is the 09-20
`leak_tag_spike` finding for `top_pair_weak_kicker_stackoff_won`, the WINNING
mirror, not the loss tag. The loss tag spiked on 09-19 (11.76 against 7.54,
+56%); on 09-20 it read 9.11 and did not trip the 1.5x rule. What is worse is
the per-hand figure: -32.60 in the 09-12 window, -39.54 in the 09-20 window.

## Which line loses

`horse_hand_reviews`, played 2026-09-14 through 2026-09-21, hold'em family,
the V24 tag or its mirror, split by whether an opponent raised or moved all in
postflop:

| class                          | line                          | hands | won   | bb/hand |
| ------------------------------ | ----------------------------- | ----- | ----- | ------- |
| top pair, kicker nine or worse | all lines                     | 1,701 | 26.2% | -39.59  |
|                                | faced a raise or an all-in    | 1,075 | 19.7% | -51.39  |
|                                | horse raised, never faced one | 336   | 40.2% | -20.37  |
| trips, kicker nine or worse    | all lines                     | 947   | 63.1% | +20.07  |
|                                | faced a raise or an all-in    | 536   | 55.0% | +8.34   |
|                                | horse raised, never faced one | 310   | 78.1% | +41.77  |

The one-pair raise and all-in lines hold 82% of that class's loss (-55,245bb
of -67,349bb). The weak-kicker trips rows are winning on every line
(`fn_horse_tag_ev('2026-09-14')` reads `weak_kicker_trips_stackoff` at
+22.91bb per hand over 2,291 hands for every non-ace kicker). The audit asked
for the class, so it is in the flag; its ceiling is its own measured win rate,
and its no-raise rule is the part of this flag most likely to cost. If the
matchup comes back negative, that half is the first suspect.

## The cap, exactly

`server/src/engine/HorseCommitCap.ts`, wired in `HorseLogic.decidePostflop`
after the V15/V20/V21 equity caps, only when `v51CommitCap === true`:

- WHO (`commitCapClass`): a hold'em-family hand (two hole cards, no-limit or
  pot-limit, one board, not a bomb pot) holding one pair of its own no better
  than top pair with a kicker of nine or worse (top pair weak kicker, a lower
  pair, an underpair), or trips made with one hole card on a board pair with a
  kicker of nine or worse. A pair the board makes for everybody is not the
  hand's own, as in the V24 detectors. Straights, flushes and full houses are
  excluded by category.
- WHERE: the pot the decision prices is 20bb or more (`COMMIT_CAP_POT_BB`, the
  review's `FLAG_BB`), the wager in front of the hand included.
- NO RAISE, NO RE-RAISE, NO JAM: the value raise, semi-bluff raise,
  check-raise bluff and river blocker raise are withheld (as the last term of
  each gate, after its roll), and the committed branch calls instead of moving
  all in.
- BOUNDED CALL-DOWN: facing an opponent's raise or all-in on the street
  (`facesRaiseOrAllIn`), the equity the decision may use is capped at the
  class's measured showdown win rate on that line: 0.20 for one pair (212 of
  1,075), 0.55 for trips (295 of 536). A plain bet is not capped.
- RECEIPTS, one per changed decision: `v51_commit_cap_no_raise`,
  `v51_commit_cap_no_jam`, and `v51_commit_cap_fold` when the same gate would
  have continued at the uncapped equity (asked without drawing from the random
  stream).
- NEVER: the nuts and every straight or better, the hand's own two pair, sets,
  trips with a ten-or-better kicker (top-kicker trips included), overpairs,
  top pair with a ten-or-better kicker, draws and air, pots under 20bb, Omaha,
  fixed limit, multi-board, bomb pots, and decisions not facing a bet. A
  certified V31 solver answer and V32's facing-defense call or fold come first
  and are left as they are; in tournaments the Phase 7 utility model still
  picks the final action and inherits the capped equity.

## Does the V15 dominated-hand floor cover sub-top-kicker trips? No.

In `HorseLogic.decidePostflop` the committed branch flats a dominated hand
through `preferFlat15 = (useV15 && vi.isOmaha && nuts15 != null && !nutClass15)
|| (useV21 && dominated21) || planCallOnly23` and labels its fold
`dominated_commitment_floor` on `dominated21 || (vi.isOmaha && made40?.weak &&
eq15 < equity)`. `nuts15` is computed only for Omaha categories 5 and 6
(`if (useV15 && vi.isOmaha && (cat === 5 || cat === 6))`), and `dominated21`
is true only for hold'em categories 5 to 7 (straights, flushes, boats). A
hold'em trips hand is category 4, so neither piece applies. The two layers
that do meet it read the category, not the kicker: V20's pressure cap
(`weakTrips = cat === 4`, the same 0.42 / 0.50 / 0.62 for every kicker) and
V21's raise-war gate (`raisedAfterAggr && cat === 4`). In Omaha, V40's
`weaktrips` class is every trips hand on a board pair, again with no kicker
read. `HorseV51CommitCap.test.ts` pins it: committed and facing a river raise,
sixes full under the jacks calls (the floor), trip kings with a four kicker
jams with no continuation guard, the four and the ace kicker play identically
with the flag off, and with it on the four kicker calls while the ace kicker
still jams.

## The league

`{ name: 'v51_commitment_cap', pairs: 6000, a: { v51CommitCap: true }, b: {} }`,
appended at the end of `LEAGUE_MATCHUPS`. `full_vs_v2_legacy` is unchanged: its
completeness check (`HorseLeagueSandbox.test.ts`) requires only the legacy
layers, and a DEFAULT OFF flag is already off on its b side.

Not inert, measured with `runMatchup(v51_commitment_cap, 1000, seed)` from a
throwaway test: seed 4242, 12 of 1,000 pairs diverged, `inert: false`; seed
20260921, 10 of 1,000 diverged, `inert: false`; zero illegal actions and zero
truncated streets at both. A 1,000-pair local run shows only that the flag
reaches code. It is not a result.
