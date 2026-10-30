# The small c-bet's size: paired-deal evidence (checklist item 17)

**Date:** 2026-10-30, 21:10 UTC. **Scope:** one league-only option,
`cbetSizeFrac` ([min, max] pot fraction replacing the small c-bet's
0.28-0.40 range in `HorseLogic.ts`), validated by `cbetSizeRange`; inert
unless set. No default changes.

## Why

Production measured small flop c-bets at -7/-8 bb a hand against +3/+5 for
big ones (human-seated NLH, October 26-29). The checkpoint held that finding
as confounded: the small size IS the brain's bluff c-bet (equity 0.18-0.52),
the big size is its value bet, so the split compares holdings, not sizes. The
owner's rule for this task: change nothing until paired-deal evidence says to.

## Evidence (duplicate-deal mirror, 20,000 pairs, seed 2026103005, six-max 100bb, A = arm, B = today's brain)

| small c-bet range | bb/100 (A) | stderr | divergent pairs |
|---|---|---|---|
| 0.50-0.60 pot | -0.38 | 0.42 | 1,123 |
| 0.66-0.75 pot | -0.57 | 0.53 | 1,158 |
| 0.20-0.25 pot | +0.48 | 0.39 | 1,119 |

Over a thousand divergent pairs per arm and nothing significant; if anything,
the sign says smaller is not worse and bigger is not better. The production
split was the confound, not a sizing leak. The finding stays unchanged, now on
evidence rather than suspicion; the option remains for a later card against
the human-calibrated field.
