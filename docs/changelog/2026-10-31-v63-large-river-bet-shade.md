# 2026-10-31: V63, the one-pair river shade steepens past a half-pot wager and caps at 20 points

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

- `v61RiverOnePairShade(toCall, pot, shape)` takes a `RiverOnePairShadeShape`
  ({slope, cap, kneeR?, kneeSlope?}). `V61_RIVER_SHADE_SHAPE` is slope 0.4,
  cap 0.12 (zero at r = 0.2, cap at a pot-sized wager). `V63_RIVER_SHADE_SHAPE`
  keeps V61's slope up to a half-pot wager (r = 1/3, 5.3 points), then
  climbs 0.88 per unit of r to a 0.20 cap at a pot-sized wager: a 0.7-pot
  wager is shaded 12 points (V61: 8), a pot-sized wager or larger 20 (V61:
  12), and nothing up to half the pot changes. The small class already
  beats its price, and a short stack's call of a covering jam reads as a
  small price in r (50 behind, pot 100, jam 500: contestable pot 150,
  r = 1/3) and stays callable (`HorseV28Postflop` A1 pins it).
- `HorseDecideOpts.v63LargeRiverBetShade` (default on; explicit false keeps
  the V61 shape) selects the shape through `riverOnePairShadeShape(opts)`
  at both V61 sites: the main river call verdict and the committed branch
  after hero bet and was raised. It lives inside V61's gates (hold'em single
  board, no bomb pot, no measured over-bluffer read, bluff-catch class only,
  off when V61 is off). `v63RiverShadeShapeOverride` exists for league
  cards only; production never sets it.
- Telemetry `v63_large_river_bet_shade` fires whenever the shade exceeds
  what V61 would have given; `HoldemLiveMeasure.RECEIPT_FEATURES` counts it.
- Ledger: flag `v63LargeRiverBetShade` (V63), flag
  `v63RiverShadeShapeOverride` (V63-league), receipt
  `v63_large_river_bet_shade`.

## League evidence

Paired-deal leagues, 8,000 pairs (16,000 hands) per card, V63 shape against
the V61 shape (`v63LargeRiverBetShade: false`), seed 2026103101 (mirror)
and 2026103102 (human field):

| card                                  | mirror bb/100  | human field    |
| ------------------------------------- | -------------- | -------------- |
| nlh 100bb, committed knee shape       | +0.68 +/- 0.43 | inert          |
| nlh 100bb, knee slope 0.66            | +0.37 +/- 0.40 | inert          |
| nlh 100bb, knee slope 1.2 / cap 0.24  | +0.69 +/- 0.48 | inert          |
| nlh 40bb                              | +0.07 +/- 0.09 | inert          |
| nlh 200bb                             | +0.45 +/- 0.47 | inert          |
| mtt 40bb (180 left / 30 paid)         | -0.03 +/- 0.16 | +0.15 +/- 0.15 |
| mtt 25bb (60 left / 30 paid)          | (not run)      | inert          |

An earlier uniform-slope cut (slope 0.8 from r = 0.2, no knee) measured
+0.84 +/- 0.52 mirror / +1.94 +/- 1.02 human field at 100bb and positive on
every other card, but it also shaded half-pot wagers 10.7 points and
turned a short stack's TPTK call of a covering jam into a fold; the knee
keeps the gain where the evidence is and leaves the small class alone.
Mirror cards are positive at 100-200bb and noise at 25-40bb; the human-field
twin never wagers more than half the pot on the river against a one-pair
caller, so it cannot see the class. The live review rows above are the
primary evidence; the before/after is read on the same subset with the same
function.

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

- `server/src/engine/HorseRiverOnePairShade.test.ts`: the shape in r
  (identical to V61 up to a half-pot wager, 12 at 0.7 pot, 20 from a
  pot-sized wager, continuous at the knee), the covering-jam price, third
  pair facing a 0.7-pot wager priced 12 points under the unshaded read by
  default and 8 with V63 off, a pot-sized wager 20 points, a quarter-pot
  wager unshaded, a set unshaded.
- `server/src/engine/HorseV28Postflop.test.ts` A1 (short stack calls a
  covering jam) stays green; the uniform-slope cut turned it red.
- `server/src/engine/HorseV17.test.ts` call-side blocker: its fixture moved
  from a 0.8-pot wager (32 into 40) to 0.65 pot (26 into 40). Under V63 an
  ace-high catcher calls the 0.8-pot wager about 0.3% of the time, so the
  blocking-versus-unblocking comparison had become two zeros; at 0.65 pot
  it calls about half the time and the ordering it pins is measurable.
- `server/src/benchmark/HoldemLiveMeasure.test.ts`: five receipt features.

## How to read the effect live

After a containing revision serves, compare
`select fn_horse_river_one_pair_calls(now() - interval '24 hours', 20000)`
with the baseline above: the medium and large cells' call counts should
fall and their win rates rise; `v63_large_river_bet_shade` receipts count
the decisions the steeper shape touched.
