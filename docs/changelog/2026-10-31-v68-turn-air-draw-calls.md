# 2026-10-31: V68, hold'em high-card TURN calls stop buying implied odds the stacks cannot pay

## What was measured

The 2026-10-31 hold'em leak report (`horse_hand_reviews`, `game_variant =
'nlh'`, 7 days, a deterministic 12 percent sample scaled to the week; the
table holds only hands with |net_bb| >= 20), leak 5: TURN calls with air or a
draw, facing a bet the horse had not made on that street.

| segment | n (sample) | won   | net bb (sample) | avg price       | weekly net bb |
| ------- | ---------- | ----- | --------------- | --------------- | ------------- |
| cash    | 494        | 29.6% | -7,337          | 0.72 pot, 16 bb | about -62,000 |
| MTT     | 383        | 36.8% |                 |                 | about -25,000 |

Air won 19-20 percent at every size (cash n=210, -5,188; MTT n=164, -4,013).
Draws won 31-35 percent against wagers of 0.7 pot or more (cash n=164,
-2,961) and were about break-even under 0.4 pot.

## The cause, read from the code

Hold'em before the river is decided by the calibrated heuristic line in
`HorseLogic.decide`:

```
eq15 + impliedBonus - shade65 - shade66 >= potOdds + 0.03 * respect + sizingPenalty + posEdge + dominationPenalty
```

1. `impliedBonus` is 0.04 for every hold'em flop/turn call with equity of
   0.25 or more and no domination penalty (`hasPhysicalImpliedDraw` is true
   for hold'em unconditionally). It assumes the river bet gets paid when the
   draw lands. Against a 0.7-pot-plus turn wager with little behind, there is
   at most one sub-pot bet left to win, so the allowance is credit the stacks
   cannot pay.
2. Air: the V65 shade already covers high card with no draw at all, because
   its class gate is `cat <= 2` and `cat` is the evaluator's category
   (1 = high card, 2 = one pair; 0 means "unknown", see below). It is
   withheld whenever `holdemDrawPresent` reads a draw, and that read counts
   a gutshot, and any four-to-a-suit or four-rank window made by the board
   alone, as a draw. High card with only one of those took no shade and the
   implied bonus besides.

## What changed

Gate (V65's, for no pair): single-board hold'em (`!isOmaha`,
`!isShortDeck`, `holeCount === 2`, no second board, no bomb pot), `street ===
'turn'`, `!raisedAfterAggr` (a wager hero did not initiate this street; the
committed branch owns the raised line), `cat === 1` (high card; `useIQ` on,
so `cat` is known), `toCall > 0 && pot > 0`.

- (a) `v68NoRoomToBePaid(potFrac, behindAfterCall, potAfterCall)`: the
  implied bonus is set to 0 when the wager is at least 0.7 of the pot before
  it and the effective stack behind after the call (hero's stack after
  calling, capped by the deepest opponent's chips behind the current bet) is
  under 1.5x the pot after the call. Otherwise it is kept, so a real draw
  with deep stacks behind calls exactly as before.
- (b) High card without a real draw (`holdemRealDraw`, the V66 read: a flush
  draw that uses a hole card, or an open-ended / double-gutter straight
  draw) that V65 left unshaded because `holdemDrawPresent` read a draw takes
  the V65 shade, `v65TurnOnePairShade(toCall, pot)`, off the equity handed
  to the call test. Withheld for a measured over-bluffer
  (`exploit.callDownMod > 1`), as V65 is. V65 and V68 (b) are exclusive by
  their draw gates, so the shade never stacks.
- Real draws keep their equity apart from (a).
- The adjusted bonus and the shade feed both the heuristic line and the V38
  `evaluateSpot` equity, exactly where V65's shade goes.
- `HorseDecideOpts.v68TurnAirDrawCalls` (default on; explicit false is the
  previous behaviour) and `v68AirShadeScaleOverride` (league only, the
  half-strength fallback; production never sets it). Telemetry
  `v68_turn_air_draw_calls` fires when (a) or (b) changes the price.
  Ledger: flags `v68TurnAirDrawCalls` (V68), `v68AirShadeScaleOverride`
  (V68-league), receipt `v68_turn_air_draw_calls`.
- The opponent-exploit neutrality corpus carries `v68TurnAirDrawCalls:
false` beside V64/V65 (the FLH cash corpus changed: the gate is read
  independent, like V65's).

## League evidence

Paired-deal leagues, 6,000 pairs per card, V68 on against
`v68TurnAirDrawCalls: false`, seed 2026103111 (mirror) and 2026103112
(human-field twin). `server/scratch/league-v68.ts`.

| card                          | mirror bb/100  | divergent pairs | human field | divergent pairs |
| ----------------------------- | -------------- | --------------- | ----------- | --------------- |
| nlh 100bb                     | +0.18 +/- 0.13 | 4               | inert, 0.00 | 0               |
| nlh 40bb                      | +0.16 +/- 0.08 | 7               | inert, 0.00 | 0               |
| mtt 40bb (180 left / 30 paid) | +0.07 +/- 0.12 | 16              | inert, 0.00 | 0               |

No illegal actions or truncated streets on any card. Every mirror card is
positive (40bb past two standard errors, 100bb past one); none is near the
-2 standard-error drop rule, so (b) ships at full strength and the
half-strength cut was not run. The human-field twin never reaches the class
on these seeds (0 divergent pairs of 6,000 per card: its field rarely bets
the turn at 0.7 pot or more into a high-card caller), so it cannot see V68;
the live review rows above are the primary evidence. The class is narrow in
a paired-deal league (4-16 divergent pairs per card), as V65's was.

## Tests

`server/src/engine/HorseTurnAirDrawCalls.test.ts` (fixture: villain raised
preflop, c-bet the flop, bets into a 36-chip turn pot; 20 seeds):

- `v68NoRoomToBePaid` boundaries (0.7 pot, 1.5x behind);
- a nut flush draw (`AhJh` on `Kh9h3s7c`) facing a pot-sized bet with deep
  stacks: 20 of 20 calls on and off, no receipt;
- the same draw with 60 behind, out of position: 20 calls off, fewer on;
- ace high with only a gutshot (`AhQd` on `KhTd3s7c`) facing a pot-sized
  bet calls less on than off, in cash and in a tournament;
- one pair (V65's), the flop, the river and Omaha are identical on and off;
- the off arm never fires; a measured over-bluffer withholds (b).

`HorseTurnOnePairShade`, `HorseBetRaisedOnePair`, `HorseDataLedger`,
`HorseOpponentExploitNeutrality` (with the off arm), `HorsePhase8Replay`,
`HorseV28Postflop` are green; `tsc --noEmit` is clean.

## Found on the way (not changed here)

- `cat === 0` is not "no pair": `bestTwoCardCategory` returns the evaluator's
  category, where high card is 1 and one pair 2; 0 is only "unknown" (street
  IQ off or an evaluator throw). V68 gates `cat === 1`. V65's `cat <= 2`
  gate therefore already shaded high-card air with no draw at all; V68 (b)
  covers only the high-card hands V65's broad draw read withheld.
- `holdemDrawPresent` (V38 / V65) reads a draw from hole and board together,
  so a four-flush or four-rank window on the board alone, which hero does
  not share, withholds V65 from one-pair hands too. V68 does not change V65.
- `impliedBonus` remains unconditional for hold'em one-pair hands with no
  draw (noted in V65); V68 touches only high card.
- The V32 defend layer's draw pass-through (`solverCall32`) returns a call
  before the heuristic line; V68 does not reach those spots.

## How to re-measure live

After a containing revision serves (the daily 04:00 America/Chicago engine
route), re-run leak 5 on `horse_hand_reviews` for the following 7 days: turn
calls with high card facing a bet the horse did not make, split air / draw
and by size class. Air call counts should fall at every size; draw calls
against 0.7 pot or more with a short stack behind should fall, and deep-stack
draw calls should be unchanged. `v68_turn_air_draw_calls` receipts in
`horse_brain_telemetry` count the decisions V68 re-priced.
