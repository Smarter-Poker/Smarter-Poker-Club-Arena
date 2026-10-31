# 2026-10-31: V63, the one-pair river shade keeps climbing against a large wager

## What was measured

`fn_horse_river_one_pair_calls(now() - 14 days, 20000)` on production at
04:16 UTC read the most recent 19,933 NLH review hands (|net| >= 20bb, the
only hands `horse_hand_reviews` keeps) and bucketed every horse one-pair
(or board-paired two-pair) river call by the wager's size class:

| size class (toCall / pot) | calls | won | win rate | price demands |
| ------------------------- | ----- | --- | -------- | ------------- |
| small (< 0.4)             | 197   | 64  | 32.5%    | 20-29%        |
| medium (0.4-0.7)          | 479   | 99  | 20.7%    | 29-41%        |
| large (>= 0.7)            | 897   | 119 | 13.3%    | 41%+          |

The 24-hour read at 03:41 UTC agreed (118/39, 297/51, 611/85). Large
wagers are the most common class a horse bluff-catches against and the one
it loses most to: V61's shade reaches its 12-point cap at half the pot, so a
pot-sized wager still demanded only 45% of a hand that wins 13%.

## What changed

- `v61RiverOnePairShade(toCall, pot, cap)` takes the cap it climbs to;
  `V61_RIVER_SHADE_CAP` is 0.12 and `V63_RIVER_SHADE_CAP` is 0.20. The slope
  is unchanged (`(toCall / pot - 0.2) * 0.4`), so every price up to half the
  pot is shaded exactly as V61 shaded it; 0.6 pot is shaded 16 points and
  0.7 pot and above 20.
- `HorseDecideOpts.v63LargeRiverBetShade` (default on, explicit false keeps
  the V61 cap) selects the cap through `riverOnePairShadeCap(opts)` at both
  V61 sites: the main river call verdict and the committed branch after hero
  bet and was raised. It lives inside V61's gates, so Omaha, short deck,
  multiple boards, bomb pots, a measured over-bluffer read, a made hand
  above the bluff-catch class and `v61RiverOnePairShade: false` are all
  unchanged.
- Telemetry `v63_large_river_bet_shade` fires when the shade exceeds the
  V61 cap; `HoldemLiveMeasure.RECEIPT_FEATURES` counts it beside V61.
- Ledger flag `v63LargeRiverBetShade` (V63) in `HorseDataLedger.ts`.

## League evidence, and why it is inert

Mirror and human-field paired-deal leagues (8,000 pairs, 100bb, 40bb and a
40bb MTT context, caps 0.16 and 0.20) were inert or within one divergent
pair: league horses never wager 0.7 pot or more on the river against a
one-pair caller (2,000-pair debug count: 270 shade calls, all between 0.0
and 0.6 pot). The league therefore proves V63 harms nothing against horses
and cannot measure the class it corrects; the live review rows above are
the evidence, and the before/after is read on the same subset with the
same function. Note for the next brain upgrade: horses never making a large
river wager is itself a gap worth measuring against live human sizing.

## Tests

- `server/src/engine/HorseRiverOnePairShade.test.ts`: shape (identical to
  V61 up to half the pot, 16 at 0.6, 20 at 0.7 and above), a 0.75-pot wager
  priced 20 points below the unshaded read by default and 12 with V63 off,
  a half-pot wager unchanged and not a V63 receipt, and a set unshaded.
- `server/src/benchmark/HoldemLiveMeasure.test.ts`: five receipt features.

## How to read the effect live

After a containing revision serves, compare
`select fn_horse_river_one_pair_calls(now() - interval '24 hours', 20000)`
with the baseline above: the large cell's call count should fall and its
win rate rise; `v63_large_river_bet_shade` receipts count the folds the cap
added.
