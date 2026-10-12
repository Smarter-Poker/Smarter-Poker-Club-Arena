# Phase 12 Sampler: Exact Kernels So Crazy Pineapple And FLO8 Finish Their Samples

## What Was Wrong

The Phase 12 completion floor (0.95 per street on the 99% Wilson lower bound) counts a
postflop decision as completed only when the live range sample finished all 32 samples the
strength matrix priced. Crazy Pineapple and FLO8 failed it because the sampler stopped at its
own deadline (`REMAINING_VARIANT_DOMAIN.samplingDeadlineMs`, 2.5 ms from the start of the
policy) before the 32nd sample.

Measured on engine release f47ad93c, decisions from 2026-10-11 19:05 to 19:45 UTC, closed
journal segments read under nice and ionice (diagnostic window, predeclared; not a completion
record):

| Pack            | Postflop decisions | Sampler budget exhausted |
| --------------- | ------------------ | ------------------------ |
| Crazy Pineapple | 1,111              | 450                      |
| FLO8            | 1,388              | 39                       |
| FLH             | 1,305              | 2                        |
| Short Deck      | 1,231              | 4                        |

Crazy Pineapple's own sampler time grew with every dealt opponent, folded or not: median
1.34 ms with one dealt opponent, 1.95 ms with two, 2.28 ms with three, and every decision
with four or five dealt opponents stopped after 14 to 19 samples. A CPU profile of the
journaled states put about 70% of the time in `choosePineappleFlopPair` and
`remainingVariantHandShape`:

- every sample chose a retained pair for every dealt opponent
  (`for (const p of dealt) hands.set(p.user_id, choosePineappleFlopPair(...))`), although
  only the contesting opponents' pairs are ever scored;
- every prior attempt rebuilt a full hand shape (validation, sets, sorts) to read one
  number, its quality.

FLO8's samples ran out on the same deadline whenever host jitter met its work: the exhausted
states take no longer than the completed ones when replayed, and about 40% of FLO8's time was
the 60 two-plus-three Omaha high scores per hand, built from card objects.

## What Changed

`server/src/engine/remainingVariants/RemainingVariantSampler.ts` only:

- the retained Pineapple pair is chosen for contesting opponents only (a folded seat's three
  cards still leave the deck; choosing its pair drew no random number and was never read);
- `remainingVariantSampledShapeQuality`, `pineappleSampledFlopPair`, the FLO8 high kernel
  (board triple counters shared by every hand of a sample) and an in-place draw
  (`drawInPlace`, `removePicked`) replace the work above;
- on the river the hero's scores are computed once per decision.

Every kernel returns exactly what the code it replaced returned, with the same random draws
in the same order, so every sample, receipt and decision is bit-identical; only the time
changes. `RemainingVariantSamplerKernels.test.ts` proves it: exhaustive equality for every
two-card, three-card and four-card hand shape and every five-card score, seeded equality for
the Pineapple pair, the FLO8 high score and the in-place draw, and the sampler's whole output
on natural controller spots pinned to the digest the original sampler produced.

Local replay of the 345 journaled host states (best of seven): Crazy Pineapple with four
dealt opponents 1.90 ms to 0.11 ms, with five 2.34 ms to 0.12 ms; FLO8 0.48 ms to 0.20 ms
(one contesting opponent) and 0.65 ms to 0.28 ms (two); output fingerprints identical for all
four packs. With the real clock, 46 of 360 Pineapple replays exhausted before and 0 after.

## What It Invalidates

The sampler file is hashed by the Phase 12 policy digest (all four packs) and the Phase 13
policy digest (all nine variants). Merging this changes those digests, so:

- the FLH selection (`PHASE12_PROTECTED_RELEASE_SELECTIONS.flh`, qualification measured at
  1235b47a) is refused `policy_digest_mismatch` until FLH is re-measured on the new source
  and a new completion window is read; three tests pin that admission today;
- every Phase 13 matrix measured on 1235b47a measures a digest that no longer runs.

Phase 10 and Phase 11 digests do not hash this file and are unchanged.
