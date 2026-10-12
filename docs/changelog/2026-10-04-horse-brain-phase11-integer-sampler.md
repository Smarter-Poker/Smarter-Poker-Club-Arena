# Horse Brain Phase 11: the variant sampler scores in integers (2026-10-04)

## Why

P11.3 admits a pack only when natural live decisions complete the measured
policy on at least 95% of every street (Wilson 99% lower bound). Read from the
journal on release `cf10fe83` (01:01-01:07Z, read-only, two-stage completion
reader), the live sampler still ran out of its 3 ms budget on most postflop
decisions:

| pack | flop    | turn    | river   |
| ---- | ------- | ------- | ------- |
| PLO5 | 46 / 60 | 13 / 48 | 26 / 35 |
| PLO6 | 17 / 57 | 5 / 51  | 37 / 38 |

(completed / eligible). The river had already improved from 57 / 123 on the
previous release after the river score reuse in #6122; flop and turn had not.
No pack could clear the floor, so no qualification could ever be admitted.

## What changed (behaviour bit-identical, work about 5x less)

`server/src/engine/omaha/OmahaVariantSampler.ts`

- Cards are reduced once per decision to integer codes; each board is reduced
  to its 3-card triples (rank masks, shared suit, 8-or-better low mask), and a
  hole pair is added to a triple as two rank bits. Same scoring arithmetic as
  `HorseFiveCardScore.scoreFiveCards`; a best over combinations is order-free.
- Five distinct ranks (no pair) are read from a precomputed table, plain and
  flush.
- The public board's non-flush score of every rank pair against every triple
  is tabulated once per decision; every prior draw reads it.
- A showdown's best is the better of the public triples (already scored by the
  prior weight, and for the hero once per decision) and the triples holding a
  drawn card, so each sample scores only the drawn triples (none on the river).

`server/src/engine/omaha/OmahaVariantPolicyPack.ts` (`omahaVariantHandQuality`)

- Rank lookup by key instead of `indexOf`, module scratch instead of per-call
  arrays, and the connected-core reading cached per distinct-rank set.

## Proof

- `OmahaVariantSamplerSpeed.test.ts`: integer high, partial high, table high and
  low are `Object.is`-identical to `scoreOmahaHi` / `scoreOmahaHiPartial` /
  `scoreOmahaLow` over 150,000 random deals for 4, 5 and 6-card hands; the fast
  hand quality stays identical to `omahaVariantHandShape` over 200,000 hands per
  pack.
- One-off equivalence run (not committed): 3,000 random spots, PLO5/PLO6/PLO8,
  flop/turn/river, 2-9 seats, folds and public lines, unlimited budget: the
  evidence object (excluding `analysisMs`) was identical to the previous
  sampler's on every spot. Same machine: total 9.8 s before, 1.9 s after; turn
  p50 3.5 -> 0.64 ms, p95 7.0 -> 1.3 ms; river p95 7.9 -> 1.2 ms.

## Consequence for the strength matrices

The policy digest hashes the sampler and the pack, so a qualification measured
on an earlier commit cannot be admitted against this code. The three matrices
dispatched on `cf10fe83` were cancelled minutes after starting and are
re-dispatched on the main commit carrying this change. Their fixed-clock
behaviour is identical (same scores, same random stream), so nothing about the
measured policy changed, only its cost.
