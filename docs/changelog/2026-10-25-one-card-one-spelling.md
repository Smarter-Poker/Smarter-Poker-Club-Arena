# 2026-10-25 - One card, one spelling

Follow-up to `2026-10-25-hero-label-sees-every-flush.md`. That fix taught the
hand evaluator to read past two suit spellings. This one removes the second
spelling at the door, so no other check can trip on it.

## The problem

Cards reached the table in three dialects:

- engine snapshots: words, `{ rank: 'T', suit: 'clubs' }`, passed through
  `mapEngineSnapshot` untouched, for the board and for the hero's own row;
- `table_hole_cards` (realtime and recovery poll): letters via
  `ENGINE_SUIT_MAP`, rank copied as sent;
- `normalizeCards` (board events): converted, but to words.

So the hero's row could be letters or words depending on which path wrote it
last, and the board was words. Every check comparing `${rank}${suit}` between
the two failed quietly: the hand label (fixed separately), the "same cards,
keep the row's order" rule in `heroDisplayHoleCards`, winning-card highlights
keyed by `cardKey`, and the Crazy Pineapple discard lookup.

## The fix

- `normalizeCard` / `normalizeCards` now produce the short form every card
  renderer already accepts: rank `2-9 T J Q K A`, suit `h d c s`.
- New `canonicalCards` converts in place without dropping or moving a slot,
  for state paths where a face-down placeholder must keep its index.
- `mapEngineSnapshot` converts hole cards and all three boards on the way in.
- TablePage's two `table_hole_cards` paths, the sync-data hero path and the
  Rabbit Hunt reveal use `canonicalCards` (the Rabbit path also no longer
  invents a heart for an unreadable suit).
- `cardKey` in `handEvaluator.ts` folds spelling too, as a second line.

## Tests

`tests/unit/oneCardOneSpelling.test.ts` pins the converter and every entry
point. Three source-pin tests that read TablePage's wording
(`heroNeverLosesTheirCards`, `timeBankSeatFeedbackAndCards`,
`rabbitRevealResponseOwnership`) were updated in the same commit to name the
converter; what each protects is unchanged.
