# V62 calibration arms, and what the mirror league said about them

**Date:** 2026-10-30, 20:50 UTC. **Scope:** two league-only options on
`HorseDecideOpts` - `v62BluffShares` (the bluff share per size class in place
of `V62_BLUFF_SHARE`) and `v62BluffCatchOnly` (polar-sample the river bettor
only when hero holds the bluff-catch class) - plumbed through the read
(`riverPolarBluffShare`) into `v62TargetClass`. Both are inert unless
`v62RiverBettorPolarity` is on, which is opt-in since #8781. No default changes.

## Results (duplicate-deal mirror, 20,000 pairs, seed 2026103004, A = arm on, B = V62 off)

| arm | 200bb | 100bb | 40bb |
|---|---|---|---|
| measured shares 0.25/0.22/0.18 (the shipped V62) | -0.53 +/- 1.03 | | |
| mid 0.30/0.27/0.24 | -1.01 +/- 0.90 | | |
| balanced 0.35/0.32/0.29 | -2.77 +/- 0.92 | | |
| wide 0.42/0.38/0.34 | **-4.63 +/- 1.00** | | |
| bluff-catch class only, measured shares | -0.49 +/- 0.86 | **-1.60 +/- 0.56** | **-0.43 +/- 0.20** |

(Seed 2026103003 earlier: shipped V62 -3.67 +/- 1.02 at 200bb, -0.40 +/- 0.55
at 100bb, -0.48 +/- 0.22 at 40bb; V61 alone +1.30 +/- 0.41 at 100bb. River
stack-offs dominate the per-pair variance at 200bb, so two seeds can differ by
two stderr there.)

## Reading

1. Giving the bettor MORE bluffs makes V62 worse, monotonically: the old
   brain's river bets are value-heavy, which agrees with the production
   measurement that one-pair river calls lose. So the loss is not "V62 folds
   too much".
2. Restricting the model to hero's bluff-catch class does not rescue it
   (-1.60 +/- 0.56 at 100bb). The remaining difference from the contact read
   inside that class is where V62 CALLS more than the contact read did: the
   small size class (bluff share 0.25 plus a 0.20 weaker-pair share in the
   value mix) hands a weak pair ~0.35-0.45 equity against a third-pot bet,
   which the contact read with a big-bet contact target did not, and against
   the old brain those small-bet calls lose. V61's price shade, which starts
   at zero under a fifth of the pot and never adds equity, is positive for
   the same reason.
3. Therefore V62 stays opt-in. A future stratum must not add equity to one
   pair against small bets; the shipped shade (V61) is the correction that
   measures positive against the fleet's own opponents.

Nothing here is live; nothing here changes a default.
