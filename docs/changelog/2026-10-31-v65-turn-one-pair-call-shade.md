# 2026-10-31: V65, hold'em one-pair TURN calls are shaded by the price of the barrel

## What was measured

The 2026-10-31 hold'em leak report (`horse_hand_reviews`, `game_variant =
'nlh'`, 7 days to 05:48 UTC, a deterministic 12 percent sample scaled to the
week; the table holds only hands with |net_bb| >= 20) ranked every class of
horse decision by weekly net. The largest was the TURN call with one pair
facing a bet the horse had not made on that street:

| segment | n (sample) | won   | net bb (sample) | avg price       | weekly net bb  |
| ------- | ---------- | ----- | --------------- | --------------- | -------------- |
| cash    | 1,727      | 33.0% | -36,436         | 0.76 pot, 19 bb | about -308,000 |
| MTT     | 1,542      | 36.8% | -22,134         | 0.72 pot, 17 bb | about -185,000 |

By the wager's size class (wager / pot before the wager), cash:

| hand class     | size     | n   | won   | net     | price demands |
| -------------- | -------- | --- | ----- | ------- | ------------- |
| one_pair:top   | < 0.4    | 198 | 50.5% | +198    | 20-29%        |
| one_pair:top   | 0.4-0.7  | 390 | 43.8% | -5,320  | 29-41%        |
| one_pair:top   | 0.7-1.05 | 512 | 28.9% | -16,744 | 41-51%        |
| one_pair:top   | >= 1.05  | 199 | 23.1% | -8,248  | 51%+          |
| one_pair:under | < 0.4    | 149 | 36.2% | -2,285  |               |
| one_pair:under | 0.4-0.7  | 371 | 31.0% | -6,700  |               |
| one_pair:under | 0.7-1.05 | 242 | 20.7% | -8,339  |               |
| one_pair:under | >= 1.05  | 53  | 18.9% | -2,409  |               |

The tournament table has the same shape (top pair 50 / 49 / 35 / 23 percent,
under pair 35 / 32 / 31 / 13). The cells at 0.7 pot and above alone are about
-302,000bb a week in cash. After calling the flop with one pair the horse
folded the turn to a second barrel 3.2 percent of the time with top pair and
9.4 percent with an under pair (cash), then paid the river too.

## The cause, read from the code

Hold'em before the river is decided by the calibrated heuristic line in
`HorseLogic.decide`:

```
eq15 + impliedBonus >= potOdds + 0.03 * respect + sizingPenalty + posEdge + dominationPenalty
```

with `sizingPenalty = (min(0.06, betRatio * 0.04) + mw * 0.5) * respect`.
`betRatio` is `toCall / pot` where `pot` already holds the wager, so a
pot-sized barrel is `betRatio = 0.5` and costs **two** points, not the six
the cap suggests (the cap is reached only at a wager of three times the
pot). `eq15` is the Monte Carlo read against the bettor's range, which does
not narrow with the size of the barrel and is the same bluff-heavy read V61
corrected on the river. In the fixture used by the tests (villain raised
preflop, c-bet the flop, bets the pot on the turn; no reads), top pair with a
weak kicker reads 0.61 against a bar of 0.37, and reads the same 0.61 facing
a three-times-pot overbet. Every hold'em one-pair hand before the river also
collects the 0.04 `impliedBonus` whether or not it has a draw
(`hasPhysicalImpliedDraw` is unconditional for hold'em); that is left as
found and noted below.

The V38 barrel continuation (`continuation38`, which prices the river bet
into the turn call) engages only with a `betCheckedTo` read on that bettor,
and such a read also sets the over-bluffer exploit (`callDownMod > 1`), so
the V65 gate withholds on that path as V61 does; the heuristic line is the
live path for this class.

## The coordinate

The shade is a function of r = toCall / (pot after the wager), the same
figure the pot odds read, because `pot` inside `decide` is the contestable pot
and already holds the wager. A quarter-pot wager is r = 0.2, a 0.4-pot wager
r = 0.29, a 0.7-pot wager r = 0.41, a pot-sized wager r = 0.5, a 2x overbet
r = 0.67. (V63's note records the same coordinate for the river shade.)

## What changed

- `v65TurnOnePairShade(toCall, pot, cap = 0.12)` in `HorseLogic.ts`: zero at
  r <= 0.2, slope 0.4 per unit of r, capped at 0.12 from a pot-sized wager:
  3.6 points at a 0.4-pot wager, 8.4 at 0.7 pot, 12 at pot and above. The
  small class is break-even live, so it is left nearly untouched.
- The shade comes off the equity handed to the call test, so the call bar
  decides, never a hard fold: on the heuristic line
  `eq15 + impliedBonus - shade65 >= ...`, and on the V38 `evaluateSpot` path
  `equity: clamp01(eqRead38 - shade65)` for the turn.
- Gates, V61's exactly, one street earlier: single-board hold'em
  (`!isOmaha`, `!isShortDeck`, `holeCount === 2`, no second board, no bomb
  pot), `street === 'turn'`, the bluff-catch class (`cat > 0 && (cat <= 2 ||
(cat === 3 && pairedBoard))`), no measured over-bluffer read
  (`exploit.callDownMod <= 1`), `toCall > 0 && pot > 0`. Two gates of its
  own: `!raisedAfterAggr` (hero bet this street and was raised: the
  committed branch owns that line, report leak 3) and
  `!holdemDrawPresent(hole, board)` (a flush or straight draw is priced as a
  draw, report leak 5).
- `holdemDrawPresent` is the V38 barrel continuation's hold'em draw read
  (four to a suit, or four distinct ranks inside one five-rank window, hole
  and board together), lifted out of that block and shared.
- `HorseDecideOpts.v65TurnOnePairShade` (default on; explicit false is the
  previous behaviour) and `v65TurnShadeCapOverride` (league cards only;
  production never sets it). Telemetry `v65_turn_one_pair_shade` fires when
  the shade is positive. Ledger: flag `v65TurnOnePairShade` (V65), flag
  `v65TurnShadeCapOverride` (V65-league), receipt `v65_turn_one_pair_shade`.

## League evidence

Paired-deal leagues, 8,000 pairs (16,000 hands) per card, V65 on against
`v65TurnOnePairShade: false`, seed 2026103105 (mirror) and 2026103106
(human-field twin):

Run on the branch after merging main at V63 (`7cb5fffc95`, the river
shade's knee shape), so the river under both arms is the shipped V63.

| card                                | mirror bb/100  | divergent pairs | human field    | divergent pairs |
| ----------------------------------- | -------------- | --------------- | -------------- | --------------- |
| nlh 100bb, cap 0.12 (shipped)       | +1.16 +/- 0.35 | 53              | -0.30 +/- 1.01 | 11              |
| nlh 100bb, cap 0.08 (fallback)      | +1.21 +/- 0.42 | 53              | -0.30 +/- 1.01 | 11              |
| nlh 40bb, cap 0.12                  | +0.41 +/- 0.14 | 26              | +0.10 +/- 0.35 | 6               |
| nlh 200bb, cap 0.12                 | +0.59 +/- 0.45 | 58              | +1.08 +/- 1.79 | 18              |
| mtt 40bb (180 left / 30 paid), 0.12 | +0.47 +/- 0.19 | 53              | +0.10 +/- 0.35 | 6               |
| mtt 25bb (60 left / 30 paid), 0.12  | +0.25 +/- 0.08 | 29              | +0.23 +/- 0.11 | 5               |

A first pass before the V63 merge (same seeds, river under V61) read
+1.40 / +1.35 / +0.41 / +0.38 / +0.44 / +0.25 mirror and the identical
human-field numbers. Every mirror card is positive, three of them past two
standard errors (100bb, 40bb, mtt 25bb) and the rest past one; no card is
negative, so the shipped cap stays 0.12 (the 0.08 cut is not
distinguishable from it at 100bb). The human-field twin diverges on only
5-18 of 8,000 pairs per card: its field rarely barrels the turn at the
sizes the shade prices, so the twin cannot see the class; its one negative
cell (100bb, -0.30 +/- 1.01) is a third of a standard error from zero on 11
divergent pairs. The live review rows above are the primary evidence; the
before/after is read on the same subset.

## Tests

`server/src/engine/HorseTurnOnePairShade.test.ts`:

- the shape in r (zero at a quarter-pot wager, 3.6 / 8.4 / 12 points at
  0.4 / 0.7 / 1.0 pot, capped for a 2x overbet) and the 0.08 cap;
- the shared draw read (flush draw, open-ender, gutshot, wheel draw; no
  draw for the pairs the shade is for);
- where the receipt fires: one pair, an under pair, ace high, two pair
  through the board pair, cash and tournament; not with the option off, not
  for a quarter-pot bet, a set, two pair of hero's own cards, a flush draw,
  a gutshot, Omaha, the river (V61 fires there instead), a measured
  over-bluffer (forty observed hands of flop barrels), or after hero's own
  turn bet was raised;
- decisions on the live heuristic line across 20 seeds: top pair weak
  kicker (`As4d` on `AhKdTs2c`, out of position) calls a pot-sized barrel
  20 of 20 with V65 off and at most 16 with it on; top pair (`As5d` on
  `AhKd9s2c`) calls a 1.5x-pot barrel 20 of 20 off and folds at least 10
  on; an under pair (`JsJd` on `Qh9d3s7c`) and second pair (`QsJd` on
  `KhQd3s7c`) call a pot-sized barrel 15+ of 20 off and fold 20 of 20 on;
  the same second pair facing a quarter-pot bet is identical on and off; a
  set is identical; a tournament folds too.

`HorseDataLedger`, `HorseV28Postflop`, `HorseV17`, `HorsePhase8Replay`,
`HorseRiverOnePairShade` are unchanged and green.

## Found on the way (not changed here)

- `impliedBonus` (0.04) is granted to every hold'em flop/turn call with
  equity >= 0.25 and no domination penalty, draw or not:
  `hasPhysicalImpliedDraw(isOmaha, draw)` returns true for hold'em
  unconditionally. A made one-pair hand with no draw is therefore priced
  four points looser than the line reads. Leak 5 in the report (turn calls
  with air or a draw) owns the implied-odds pricing; it is not touched here
  so V65 measures one thing.
- `sizingPenalty`'s 0.06 cap is reached at `betRatio = 1.5`, a wager of
  three times the pot; the comment and the report both read it as the
  pot-sized cost.
- With no reads, the Monte Carlo read for top pair against a turn barrel is
  the same (about 0.61 in the fixture) at a quarter pot, a pot and three
  times the pot. The shade prices the size; the range read still does not.
- The V38 barrel continuation cannot carry the shade in practice (see the
  cause above): a `betCheckedTo` read that engages it also engages the
  over-bluffer exploit that withholds V61 and V65.

## How to re-measure live

After a containing revision serves (the daily 04:00 America/Chicago engine
route), re-run the report's turn class on `horse_hand_reviews` for the
following 7 days: turn calls with one pair facing a bet the horse did not
make, by size class. The 0.7-pot-and-up cells' call counts should fall and
their win rates rise toward the price; the turn fold rate after a flop call
with one pair should rise from 3-9 percent. `v65_turn_one_pair_shade`
receipts in `horse_brain_telemetry` count the decisions the shade touched;
`v38_ev_call` / `v38_ev_fold` are unaffected because the heuristic line, not
the EV engine, decides this class.
