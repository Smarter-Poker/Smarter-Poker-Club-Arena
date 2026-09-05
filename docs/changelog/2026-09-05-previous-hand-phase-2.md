# 2026-09-05 - Previous Hand build plan, Phase 2 of 7: equity and EV on the rundown

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`.

## The all-in block (the engine's own numbers)

`ca_hand_facts` has stored, per hand and per viewer, the engine's EXACT all-in
equity at the first all-in point, the pot share that equity was worth, and the
EV net beside the real net - since 2026-08-21, read by the stats page's luck
graph and by nothing a player sees on a hand. The same RLS read that already
fetches the viewer's own cards now carries these facts (`HeroHandFacts`), and
`HandDetailView` renders an "All In On The Flop" block: Your Equity, At Risk,
Expected Back, Got Back, Expected Net, Actual Net, and "Ran Above / Below
Expectation By X". Nothing in it is computed on the client.

## Made hands and equity, street by street

`buildReplay` now records, per street, who was still in when it began
(`contenders`) and the made hand for every contender whose cards the viewer
can see (`madeHands`), named by the same evaluator as the showdown.

`utils/equity.ts` prices a street from the cards the record shows: exact where
the runout can be enumerated (turn: 44, flop: 990), sampled preflop and marked
with a tilde. A street is priced ONLY when every contender's cards are known;
one unknown holding and the street is left blank rather than filled from a
range assumption. Hi-lo variants are priced for the high half only and say so.
Omaha's exactly-two rule and the short deck's 36 cards come from the shared
evaluator, so an equity can never disagree with the hand name beside it.

The view computes equities on demand (`useStreetEquities`, memoised per model),
so the list of fifty hands pays nothing until a hand is opened.

## Pins

`tests/unit/previousHandPhase2.test.tsx`: exact turn (8 of 44), exact flop
(990), sampled preflop within the known AA-KK number, chops, refusal of a
duplicated card, Omaha and hi-lo labelling, the 36-card deck; the model's
contenders and made hands; the rendered all-in block and per-street facts, and
that an unknown contender prices nothing.

## Deep-dive review before Phase 3 (same day)

- The replayer's Rundown tab rendered `HandDetailView` without the viewer's
  facts, so the All-In block appeared on the panel, the modal and the archive
  but not on the replay of the same hand. Wired; a pin now checks all four
  surfaces pass `viewerFacts`.
- `all_in_street` can be `pineapple_discard` (the engine's own stage name);
  the block now reads "All In At The Discard" instead of "All In".
- Reviewed and unchanged: `equity.ts` dedupes on `cardKey` after
  `toDeckCards` normalises "10" to "T", so a ten cannot be double-counted;
  contenders are frozen at street start and folds accumulate across streets;
  the viewer's own folded cards ARE priced on the street they folded (that is
  the point), and excluded from the next.
