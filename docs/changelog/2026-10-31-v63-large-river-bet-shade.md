# 2026-10-31: V63, the one-pair river shade climbs twice as fast and caps at 20 points

## What was measured

`fn_horse_river_one_pair_calls(now() - 14 days, 20000)` on production at
04:16 UTC read the most recent 19,933 NLH review hands (|net| >= 20bb, the
only hands `horse_hand_reviews` keeps) and bucketed every horse one-pair
(or board-paired two-pair) river call by the wager's size class, measured
as wager / pot BEFORE the wager:

| size class (wager / pot before) | calls | won | win rate | price demands | V61 shade |
| ------------------------------- | ----- | --- | -------- | ------------- | --------- |
| small (< 0.4)                   | 197   | 64  | 32.5%    | 20-29%        | 0-3 pts   |
| medium (0.4-0.7)                | 479   | 99  | 20.7%    | 29-41%        | 3-8 pts   |
| large (>= 0.7)                  | 897   | 119 | 13.3%    | 41%+          | 8-12 pts  |

The 24-hour read at 03:41 UTC agreed (118/39, 297/51, 611/85). Large
wagers are the most common class a horse bluff-catches against and the one
it loses most to.

## The coordinate, stated so it is not misread again

The shade is a function of the price r = toCall / (pot after the wager),
the same figure the pot odds read, because `pot` inside `decide` is the
contestable pot and already holds the wager. A pot-sized wager is r = 0.5,
a 0.7-pot wager r = 0.41, a 0.4-pot wager r = 0.29, a 2x overbet r = 0.67.
V61's note said its 12-point cap was reached "at half the pot"; it is
reached at a pot-sized wager (r = 0.5), and a 0.7-pot wager was shaded only
8 points. The first cut of this change raised the cap "from 0.7" in r and
would have touched only overbets above 2.3x the pot; the league showed it
inert and the coordinate was corrected before anything merged.

## What changed

- `v61RiverOnePairShade(toCall, pot, cap, slope)`; `V61_RIVER_SHADE_SLOPE`
  0.4 / `V61_RIVER_SHADE_CAP` 0.12 and `V63_RIVER_SHADE_SLOPE` 0.8 /
  `V63_RIVER_SHADE_CAP` 0.20. Both start at r = 0.2 (a quarter-pot wager).
  V63 shades a 0.4-pot wager 7 points (V61: 3), a 0.7-pot wager 17 (V61: 8)
  and a pot-sized wager or larger 20 (V61: 12).
- `HorseDecideOpts.v63LargeRiverBetShade` (default on; explicit false keeps
  the V61 shape) selects the shape through `riverOnePairShadeShape(opts)`
  at both V61 sites: the main river call verdict and the committed branch
  after hero bet and was raised. It lives inside V61's gates (hold'em single
  board, no bomb pot, no measured over-bluffer read, bluff-catch class only,
  off when V61 is off). `v63RiverShadeCapOverride` / `v63RiverShadeSlopeOverride`
  exist for league cards only; production never sets them.
- Telemetry `v63_large_river_bet_shade` fires whenever the shade exceeds
  what V61 would have given; `HoldemLiveMeasure.RECEIPT_FEATURES` counts it.
- Ledger flag `v63LargeRiverBetShade` (V63) in `HorseDataLedger.ts`.

## League evidence

Paired-deal leagues, 8,000 pairs (16,000 hands) per card, V63 shape against
the V61 shape (`v63LargeRiverBetShade: false`), seeds 2026103101 (mirror)
and 2026103102 (human field):

| card                        | mirror bb/100   | human-field bb/100 |
| --------------------------- | --------------- | ------------------ |
| nlh 100bb, slope 0.8 cap 0.20 | +0.84 +/- 0.52  | +1.94 +/- 1.02     |
| nlh 100bb, slope 0.6 cap 0.20 | +0.76 +/- 0.45  | +1.33 +/- 0.90     |
| nlh 100bb, slope 1.2 cap 0.24 | +1.02 +/- 0.61  | +1.67 +/- 1.59     |
| nlh 40bb, slope 0.8           | +0.16 +/- 0.17  | +0.38 +/- 0.22     |
| nlh 200bb, slope 0.8          | +0.85 +/- 0.58  | +2.36 +/- 1.23     |
| mtt 40bb (180 left / 30 paid) | -0.08 +/- 0.23  | +0.67 +/- 0.33     |
| mtt 25bb (60 left / 30 paid)  | +0.08 +/- 0.16  | +0.35 +/- 0.20     |

Thirteen of fourteen cards resolved positive and the fourteenth (mirror
mtt 40bb, -0.08 +/- 0.23) is noise around zero; the steeper slope 1.2 was
not taken because its human-field error bar is the widest and the live
classes it would touch most (small wagers) already win more than their
price. Divergent pairs are few
(league horses rarely wager a pot or more on the river, so most of the
corrected class never arises against horses) and the live review rows above
are the primary evidence; the before/after is read on the same subset with
the same function.

## Found on the way (not changed here)

- Second pair raises a 0.7-pot river wager 3-4x in the fixture
  (`9s8d` on `Qh9d3s7c2c`, 28 into 40 -> raise to 120) while third pair
  calls. Live, horse river raises holding one pair or air are called 85-95%
  of the time and lose: cash one-pair raises 109 (-4,184bb, 34% won), cash
  air raises 42 (-1,696bb, 7% won) over the latest 10,973 review hands,
  while raises with two pair or better earned +16,000bb. That is the next
  correction (V64).
- Horses do make large river wagers live (cash strong-hand wagers over the
  pot: 499, won 88%), so the earlier "horses never bet large" reading from
  the league was the coordinate error above, not a sizing gap.

## Tests

- `server/src/engine/HorseRiverOnePairShade.test.ts`: the shape in r (0 at a
  quarter-pot wager, 7 at 0.4 pot, 17 at 0.7 pot, 20 from a pot-sized
  wager; V61 3/8/12 for the same wagers), third pair facing a 0.7-pot wager
  priced 17 points under the unshaded read by default and 8 with V63 off, a
  pot-sized wager 20 points, a quarter-pot wager unshaded, a set unshaded.
- `server/src/benchmark/HoldemLiveMeasure.test.ts`: five receipt features.

## How to read the effect live

After a containing revision serves, compare
`select fn_horse_river_one_pair_calls(now() - interval '24 hours', 20000)`
with the baseline above: the medium and large cells' call counts should
fall and their win rates rise; `v63_large_river_bet_shade` receipts count
the decisions the steeper shape touched.
