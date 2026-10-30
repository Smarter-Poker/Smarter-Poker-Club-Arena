# Tournament flats of an open: paired-deal evidence

**Date:** 2026-10-30, 22:35 UTC. **Scope:** one league-only option,
`tournamentFlatBump` (0 < x <= 0.2, added to the tournament call bar facing a
single open with no callers; the 3-bet bar does not move), plumbed through
`PreflopCtx.tournamentFlatBump`. Inert unless set. No default changes.

## Why

Production (October 26-29, human-seated NLH tournament hands) measured
flatting a single open at -8.7 bb a hand on 54 hands, one of the two losing
preflop lines. The checkpoint held it as inconclusive (n = 54, confounded by
the two 400-800bb level-1 pots that dominate the other losing line).

## Evidence (duplicate-deal mirror, MTT context 180 left / 30 paid, six-max, 20,000 pairs, seed 2026103006, A = tighter flat, B = today's brain)

| call bar raised by | 100bb | 40bb |
|---|---|---|
| +0.06 | **-1.11 +/- 0.51** (583 divergent pairs) | +0.41 +/- 0.31 (492) |
| +0.12 | -0.84 +/- 0.71 (990) | +0.66 +/- 0.40 (811) |

Tightening the flat deep LOSES against the fleet's own brain, and at 40bb it
is at best a small gain that does not reach significance. The production
figure does not survive paired deals; the finding stays unchanged. The option
remains for a human-field twin and for a stack-aware variant (40bb only) if
a larger sample ever makes that significant.
