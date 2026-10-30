# V62 river bettor polarity is opt-in: the paired-deal league resolved it negative against horses

**Date:** 2026-10-30, 18:50 UTC. **Scope:** `server/src/engine/HorseLogic.ts`
(one gate: `opts.v62RiverBettorPolarity === true`), its option note,
`HorseDataLedger.ts` flag note, `HorseRiverBettorPolarity.test.ts`,
`HorseRiverOnePairShade.test.ts`, `HorseV54RiverBluff.golden.json` (one entry
re-recorded under the default that now serves).

## The evidence (duplicate-deal mirror league, 20,000 pairs each, seed 2026103003)

The owner's standing rule for this task: keep a finding unchanged until
paired-deal evidence supports a change. V62 (#8733) was calibrated to the
measured HUMAN pool's river bluff shares (one-pair calls won 14-22% in review
stack-offs). Against the fleet's own old brain as the opponent - which is
most of what a horse faces - the mirror says:

| matchup (A = on, B = off) | bb/100 (A) | stderr | divergent pairs |
|---|---|---|---|
| V62, 200bb six-max | **-3.67** | 1.02 | 280 |
| V62, 40bb six-max | **-0.48** | 0.22 | 138 |
| V62, 100bb six-max | -0.40 | 0.55 | 236 |
| V61 alone (V62 off both arms), 100bb | **+1.30** | 0.41 | 124 |
| V60 cash pressure, 100bb (3,000 pairs) | -0.89 | 2.60 | 211 |

Human-calibrated field twins (12,000 pairs): V62 -1.16 +/- 2.34 (48 divergent
pairs), V61 alone -2.17 +/- 2.29 (9), V60 +9.74 +/- 7.91 (165) - the
calibrated field almost never puts a horse's one pair in front of a river
bet, so the twins have no power here either way.

The old brain bluffs rivers more than the human pool does (V54 river bluffs
run at the balanced share by construction), so a stratum built on 18-25%
bluffs folds one pair too often against it, and deep stacks magnify the
cost. V61's price shade, which V62 had been suppressing (V61 yields to V62),
resolves significant positive on its own.

## What changed

`v62RiverBettorPolarity` is opt-in: unset is off, exactly as `false` was. V61
therefore carries the measured correction by default; everything else in #8733
(the stratum sampler, the per-call index, the receipts, the corpus off arm)
stays and is reachable with the option. The V54 golden entry
`nlh_air_facing_bet` is re-recorded under the default that serves (the 24
seeds still split 21 folds / 3 all-in bluff-raises, as before V62). No
production default other than V62's changes; nothing is live.

## Next

Recalibrate the V62 strata to the whole population (horse bettors included),
or make the bluff share come from the measured opponent read, and re-run this
card; re-enable by default only on a significant positive mirror result and
a human-field twin that is at least neutral.
