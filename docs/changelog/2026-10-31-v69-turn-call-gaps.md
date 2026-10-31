# 2026-10-31: V69, three hold'em turn-call gaps left by V65 / V68 are closed

V65 (one-pair turn call shade) and V68 (high-card turn implied odds) each
recorded a gap they deliberately left alone so they would measure one thing.
V69 closes the three, under one option.

## The three gaps, read from the code

1. **One pair still bought implied odds the stacks could not pay.**
   `impliedBonus` (0.04) is granted to every hold'em flop/turn call with
   equity >= 0.25 and no domination penalty, because
   `hasPhysicalImpliedDraw` is true for hold'em unconditionally. V68 (a)
   withheld it for high card (`cat === 1`) when `v68NoRoomToBePaid` holds;
   one pair (`cat === 2`) kept it.
2. **V65's draw exemption read a board-only draw as hero's.** The V65 gate
   withholds the shade when `holdemDrawPresent(hole, board)` is true, and
   that read counts four to a suit or a four-rank window across hole and
   board together. A four-flush or four-rank window made by the board alone,
   with no hole card in it, therefore exempted a one-pair hand from the
   shade although hero has no draw at all.
3. **The V32 draw pass-through skipped V68.** When the (opt-in) V32 defend
   layer judged a drawing hand a call, it set `solverCall32`, and the call
   was returned before the heuristic line where V68 (a) lives.

## What changed

`HorseDecideOpts.v69TurnCallGaps` (default on; explicit false is the
previous behaviour for all three):

1. **One-pair implied odds.** Under V68 (a)'s gates (single-board hold'em:
   `!isOmaha`, `!isShortDeck`, `holeCount === 2`, no second board, no bomb
   pot; `street === 'turn'`; `!raisedAfterAggr`; `useIQ`; `toCall > 0 &&
pot > 0`) with `cat === 2`, the implied bonus is 0 when
   `v68NoRoomToBePaid(potFrac, behindAfterCall, pot + toCall)` holds (wager
   > = 0.7 pot and the effective stack behind after the call under 1.5x the
   > pot after the call). Deep stacks keep the bonus.
2. **Hole-card draws only, for the V65 gate.** New
   `holdemHoleDrawPresent(hole, board)`: `holdemDrawPresent`'s shapes,
   counted only when a hole card is part of the draw (a hole card of the
   four-suit, or a hole rank adding a rank the board does not already hold
   inside the window). `holdemRealDraw` was not reused because it also
   drops gutshots, and V65's gutshot exemption is pinned and out of scope.
   Only the V65 gate uses the new read; the V38 continuation and V68 (b)
   keep `holdemDrawPresent`. V68 (b) now also requires `shade65 === 0`, so a
   high-card board-only shape that V65 now shades is not shaded twice (with
   V69 off that guard is a no-op: the two gates were already exclusive).
3. **V32 pass-through.** In the drawy branch of the V32 defend layer, on the
   turn, when `v68NoRoomToBePaid` holds the call is no longer guaranteed:
   `solverCall32` stays false and the decision falls through to the normal
   line (which then also takes V68 (a)). Flop pass-through, made-hand
   calls, folds and `pass_strong` are unchanged.

- `v68BehindAfterCall(stack, toCall, currentBet, opponents)` is the V68
  effective-stack computation lifted into a shared helper (V68 behaviour
  unchanged).
- Telemetry `v69_turn_call_gaps` fires when (1) withholds the bonus, when
  (2) lets V65 shade a hand the old read exempted, or when (3) withholds the
  pass-through. Ledger: flag `v69TurnCallGaps` (V69), receipt
  `v69_turn_call_gaps`.
- The opponent-exploit neutrality corpus did not diverge; no off arm added
  there. The V53 byte-identity corpus (`HorseOmahaTournamentPressure.test.ts`,
  `mind: false`) did: its NLH digest moved with V69 on, so
  `CORPUS_BASE_OPTS` in `HorseOmahaTournamentPressureCorpus.test-support.ts`
  carries `v69TurnCallGaps: false` beside V61's off arm, exactly as V61 did.
  The pinned digests are unchanged.
- Gap 3 is production-inert today: `v32FacingDefense` is opt-in (default off
  since 2026-10-16). It is live for any league or arm that turns V32 on.

## League evidence

Paired-deal leagues, 6,000 pairs (12,000 hands) per card, V69 on against
`v69TurnCallGaps: false`, seed 2026103113 (mirror) and 2026103114
(human-field twin). `server/scratch/league-v69.ts`.

| card                          | mirror bb/100  | divergent pairs | human field | divergent pairs |
| ----------------------------- | -------------- | --------------- | ----------- | --------------- |
| nlh 100bb                     | +0.32 +/- 0.26 | 2               | inert, 0.00 | 0               |
| nlh 40bb                      | +0.01 +/- 0.19 | 8               | inert, 0.00 | 0               |
| mtt 40bb (180 left / 30 paid) | +0.23 +/- 0.12 | 14              | inert, 0.00 | 0               |

No illegal actions or truncated streets. No card is negative, none near the
-2 standard-error drop rule, so all three gaps ship. The class is narrow in
a paired-deal league (2-14 divergent pairs) and the human-field twin never
reaches it, as with V65 / V68; the live review rows those changelogs cite
are the primary evidence.

## Tests

`server/src/engine/HorseTurnCallGaps.test.ts` (the V65 / V68 fixture: a
36-chip turn pot, 20 seeds):

- `holdemHoleDrawPresent` against `holdemDrawPresent`: board-only
  four-flush and four-rank window are not hero's draw; a hole flush card, a
  hole open-ender and a wheel draw are.
- (1) `As4d` on `AhKdTs2c` facing a pot-sized bet with 60 behind: 16 of 20
  calls off, 7 on (receipt 20 of 20); deep stacks identical.
- (2) `Ks5d` on `KhQh9h2h` facing a pot-sized bet: 20 calls and no V65
  receipt off; V65 and V69 receipts 20 of 20 and 0 calls on. A real
  hole-card flush draw (`Ks5h` on `Kd9h3h7h`) is identical, no receipt.
- (3) V32 on, turn cells loaded: `Ah5h` on `Kh9h3s7c` facing a 1.25-pot
  bet with 60 behind: 20 pass-throughs and 20 calls off; no pass-through,
  receipt 20 of 20 and 0 calls on. Deep stacks identical, pass-through
  kept.
- the flop, the river and Omaha are identical on and off; the off arm never
  fires the receipt.

`HorseTurnOnePairShade`, `HorseTurnAirDrawCalls`, `HorseBetRaisedOnePair`,
`HorseDataLedger`, `HorseOpponentExploitNeutrality`, `HorsePhase8Replay`,
`HorseV28Postflop`, `GtoFacingDefenseV32`, `HorseV32Wiring` are green;
`tsc --noEmit` is clean. No pinned digest or expectation changed; the V53
corpus gained the V69 off arm (above).

## Found on the way (not changed here)

- V32's bet buckets (`betBucketForFraction`) answer only below 0.6 pot
  (`bet_small`) and from 1.1 pot (`bet_big`); 0.6-1.1 pot returns no range,
  so a pot-sized turn bet never reaches V32 at all. Gap 3 can therefore only
  touch overbets of 1.1 pot and up.
- `impliedBonus` is still unconditional for hold'em one pair with deep
  stacks behind, draw or not (V65's note); V69 only removes it where there
  is no room to be paid.

## How to re-measure live

After a containing revision serves (the daily 04:00 America/Chicago engine
route), re-run the turn one-pair class on `horse_hand_reviews` for 7 days:
calls of 0.7 pot or more with a short stack behind should fall, and one-pair
calls on four-flush / four-straight boards should be shaded like the rest of
the class. `v69_turn_call_gaps` receipts in `horse_brain_telemetry` count the
decisions V69 re-priced.
