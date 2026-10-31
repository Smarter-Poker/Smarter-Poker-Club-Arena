# 2026-10-31: V64, a hold'em bluff-catcher never raises the river

## What was measured

The latest 10,973 NLH review hands on production (`horse_hand_reviews`,
|net| >= 20bb, the only hands the table keeps), bucketed by what the horse
held when it RAISED a river wager:

| game | hero class at the raise | raises | won   | net        | note                                    |
| ---- | ----------------------- | ------ | ----- | ---------- | --------------------------------------- |
| cash | one pair                | 109    | 34%   | -4,184bb   | called 85-95% of the time               |
| cash | air (high card)         | 42     | 7%    | -1,696bb   | called 35 of 37 in the 0.4-0.85 pot class |
| MTT  | one pair / air          |        | <50%  | negative   |                                         |
| both | two pair or better      |        |       | +16,000bb  | the raises that earn                    |

A river raise with one pair or air is a raise nobody folds to. The raises
with two pair or better are the ones that pay, and they are untouched.

## The mechanism

`HorseLogic.decidePostflop`, facing a wager: the value-raise branch
(`eq15 >= valueRaiseThresh`, 0.72 on the river) sat in front of the V38
call verdict. `eq15` for one pair against a river bettor reads 0.72+
because the range read is too bluff-heavy, the same cause V61 and V63
corrected on the call side. In the engine fixture (9s8d on Qh9d3s7c2c,
villain bets 28 into 40 after check-check flop and turn, hero 400 behind,
cash 2bb blinds, mind off) second pair raised to ~120 in 16 of 20 seeds
while third pair called; with the mind on, top pair (KQ facing 20 into 40)
raised 58 of 100 seeds.

Two bluff-raise origins were open on the river as well: the V8 scare-card
check-raise bluff (not river-gated) and the V8 river blocker raise-bluff
(ace-high with the nut blocker, measured 26 of 300 seeds with the mind on).

What changed, all inside `server/src/engine/HorseLogic.ts`:

- `bluffCatch64`: single-board hold'em (`!vi.isOmaha`, `!vi.isShortDeck`,
  `vi.holeCount === 2`, no multi-board, `!gs.bombPot`), river, and V61's
  class (`cat <= 2`, or `cat === 3` only through the board's pair). The read
  is of hero's own hand and the board; nothing keys on who is betting
  (CLAUDE.md 10.5).
- In the class, a hand that clears `valueRaiseThresh` no longer enters the
  value-raise branch; the scare-card check-raise bluff and the blocker
  bluff-raise are closed too. All three fall through to the existing V38
  `riverCallVerdict` with the V61 shade in its V63 shape (#8851, merged
  before this). Each redirect fires `v64_river_raise_needs_two_pair`.
- `overFolder64 = exploit.bluffMod > 1.05` keeps the two bluff-raises alive
  against a measured over-folder: HorseMind raises `bluffMod` to 1.45 only
  after 8+ observed fold-to-aggression spots at a 62%+ fold rate, a read of
  public play that already scales `bluffScale`. It never admits a one-pair
  value raise.
- `HorseDecideOpts.v64RiverRaiseNeedsTwoPair` (default on; explicit false
  keeps the old raises). Ledger flag `v64RiverRaiseNeedsTwoPair` (V64) and
  receipt `v64_river_raise_needs_two_pair` in `HorseDataLedger.ts`.
- Flop, turn, Omaha, short deck, multi-board and bomb pots are untouched.

## League evidence

Paired-deal leagues, 8,000 pairs (16,000 hands) per card, V64 on against
`v64RiverRaiseNeedsTwoPair: false`, seeds 2026103103 (mirror) and
2026103104 (human field twin), `server/scratch/league-v64.ts`:

| card                          | mirror bb/100   | divergent | human-field bb/100 | divergent |
| ----------------------------- | --------------- | --------- | ------------------ | --------- |
| nlh 100bb                     | +0.01 +/- 0.01  | 1         | +1.44 +/- 1.05     | 2         |
| nlh 40bb                      | -0.09 +/- 0.07  | 4         | +0.40 +/- 0.40     | 1         |
| nlh 200bb                     | +0.12 +/- 0.23  | 4         | -2.42 +/- 3.46     | 2         |
| mtt 40bb (180 left / 30 paid) | inert           | 0         | inert              | 0         |
| mtt 25bb (60 left / 30 paid)  | +0.02 +/- 0.03  | 2         | inert              | 0         |

The league is near-inert: at most four divergent pairs in 8,000. Against
league horses a river wager arrives after barrels that narrow the bettor's
range, so one pair rarely reads 0.72+ there; the corrected class arises
against the live field (check-check lines, wide human river bets), which is
why the review rows above are the primary evidence. Every card is within
noise of zero and none regresses; the one negative point estimate (human
200bb, -2.42 +/- 3.46) is two pairs wide.

## Tests

- `server/src/engine/HorseRiverRaiseDiscipline.test.ts`: second pair facing
  28 into 40 reaches `riverCallVerdict` in 20 of 20 seeds and never raises
  (16+ redirects); the off arm raises 12+ of 20; two pair of both hole cards
  (Qs9c) raises at exactly the old frequency with identical actions; a set
  raises; board-paired two pair (Qs4d on Qh9d3s9c7c) is a bluff-catcher;
  ace-high with the nut blocker (mind on, 200 seeds) never bluff-raises while
  the off arm does; top pair with the mind on is redirected (off arm raises
  40+ of 100); Omaha, flop and turn produce identical actions with the gate
  on and off; tournaments are covered.
- `server/src/engine/HorseLogic.test.ts`, "V8 adds river blocker
  raise-bluffs": the V8 region is now pinned on the historical arm
  (`v64RiverRaiseNeedsTwoPair: false`) and the default arm is pinned to make
  zero such raises. Changed deliberately in this commit.

## How to read the effect live

After a containing revision serves, re-run the same review read: horse river
raises grouped by hero class (one pair / air / two pair+) over
`horse_hand_reviews` since the serving time, cash and MTT separately. The
one-pair and air raise counts should fall to the over-folder residue (air
only) and the two-pair+ raise count and its net should be unchanged.
`v64_river_raise_needs_two_pair` receipts count the decisions redirected to
the call verdict; `v61_river_one_pair_shade` fires should rise by about the
same number, since those decisions now reach the shaded verdict.
