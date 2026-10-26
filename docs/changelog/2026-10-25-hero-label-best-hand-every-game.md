# 2026-10-25 - The hero's label names the best hand in every game

Third pass on Dan's ruling for the label under the hero's seat: "IT MUST 100%
OF THE TIME DISPLAY THE BEST CURRENT HAND THAT THE USER HAS." The first two
(`2026-10-25-hero-label-sees-every-flush.md`,
`2026-10-25-one-card-one-spelling.md`) made the evaluator see every card. A
line-by-line read of the label itself found three more ways it could name
something other than the hero's best hand. Game mix measured on production
for the 24 hours to 23:50 UTC: ~1.25M hands, Omaha (PLO4/5/6/8, FLO8) ~620k,
hi-lo ~96k, multi-board hands ~790.

## What was wrong

1. **Preflop trips and quads in Omaha and Pineapple.** The inline preflop
   branch counted ranks across the whole holding, so A-A-A-K in PLO read
   "Three of a Kind" and A-A-A-A "Four of a Kind". Omaha plays exactly two
   from the hand and Pineapple keeps two, so before the flop the best hand in
   every board game is a pair.
2. **Hi-lo named half the hand.** PLO8 and FLO8 split the pot with the best
   qualifying low; the label showed the high hand only.
3. **Multi-board pots named one board.** Double- and triple-board bomb pots
   deal full independent boards (`HandController` fills `communityCards2/3`
   street by street); the label read board 1.

## Fix

- New `src/lib/heroHandLabel.ts` holds the whole rule set as a pure, tested
  function; TablePage's memo calls it with the hole cards and every board,
  keyed on the cards exactly as before (`fourTablesAreNotFourOfEverything`
  still pins that).
- Preflop: "Pair" if any two hole cards pair, otherwise "<Rank> High".
- Hi-lo: `Flush · 8-7 Low` when a low qualifies, the high hand alone when not.
- Multi-board: `Flush / Two Pair`, one name per dealt board, in board order.
- Only readable cards name a hand; a placeholder or null never does.
- The unused inline `RANK_ORDER` / `RANK_WORD` helpers and the
  `isPineappleVariant` import left TablePage with the branch they served.

## Tests

- `tests/unit/heroHandLabel.test.ts` - every rule above, plus the reported PLO5
  hand, in both card spellings, and a pin that TablePage uses the module.
- `tests/unit/seatLabelAgreesWithTheEngine.test.ts` gains a hi-lo block: 4,500
  seeded PLO8 deals where the seat's low must equal the engine's
  `evaluateOmahaLowHand` low.
