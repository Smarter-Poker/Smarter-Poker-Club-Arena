# Omaha card facts: the one-card transitions without re-filtering (2026-10-05)

## Why

The P11.3 natural completion window on release `90ffa0f2` (03:02-03:50Z,
predeclared in `docs/evidence/phase11/declaration-p11-3-completion.txt`) showed
the integer sampler had fixed the river (PLO5 223 / 225, PLO6 321 / 321) but not
the turn (PLO5 232 / 318, PLO6 185 / 426), with most PLO6 turn losses being
`sampleUnavailable` and `workBudget`: the sampler's 3 ms is measured from the
start of the policy, and something before it was spending most of it.

It was `omahaCardFacts` (`server/src/engine/omaha/OmahaCardFacts.ts`), which
every Omaha policy calls first (PLO4 kernel, the PLO5/PLO6/PLO8 packs, FLO8,
and the benchmark reference). On a flop or turn it builds a transition for each
of the ~45 unseen cards, and each transition re-filtered the whole unseen deck
by string key, rebuilt rank masks with `indexOf`, allocated every hole pair and
board triple for its straight checks, and recomputed the current board's flush
facts. Measured on random 6-seat spots: 1.1-2.0 ms at p50 and up to 2.8 ms at
p95 for the facts alone, out of a 3 ms sampler budget.

## What changed (output identical)

- Ranks by table lookup, not `indexOf`.
- Straights from integer rank bits in nested loops, the straight read from a
  mask-to-high table; no pair/triple arrays.
- Opponent straight possibilities from a rank mask: removing a transition card
  removes its rank only when it was the last unseen card of that rank.
- Flush facts from per-suit value lists computed once; a transition changes
  only its own suit (gains the card on the board, loses it from the unseen
  cards). The current board's flush facts are computed once, not per card.
- The unseen deck minus the card is built only where the nut-low check needs it.

## Proof

- The new implementation's JSON output equalled the previous implementation's
  on 40,000 random deals (4/5/6-card hands, every board length, with and without
  transitions and low) and 20,000 suit- and low-heavy deals. 6.3x less time over
  the 40,000 (24.7 s -> 3.9 s).
- `server/src/engine/omaha/OmahaCardFactsSpeed.test.ts` pins the sha256 of the
  previous implementation's facts over those 40,000 deals.
- Whole PLO5/PLO6/PLO8 policy, random 6-seat spots: turn p95 3.1-3.2 ms ->
  1.6-2.0 ms; flop p95 2.8-3.2 ms -> 1.7 ms; facts p95 now 0.25-0.41 ms.

## Digest note

`OmahaCardFacts.ts` is hashed by both the Phase 10 and Phase 11 policy
digests, so both move. Neither phase has a qualification to invalidate: Phase
10 closed without promotion, and every Phase 11 pack failed its P11.2 matrix
(see the Phase 11 closure record).
