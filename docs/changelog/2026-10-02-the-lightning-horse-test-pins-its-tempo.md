# 2026-10-02 — the Lightning horse test pins the tempo it is about

Engine release run 37021851186 (and CI runs 37006273301, 37016574311) failed on
`server/src/lightning/LightningHandHost.test.ts` "a horse acts through the same
clock and the same door, inside its deadline": `expected 'dealing' to be
'complete'`.

## Cause

Not a race and not CPU load. The fixture's horse lane answers with the real
brain, and the brain's V14 tempo is a random mixture: snap, beat, tank, and a
deliberate time-bank burn. The test drove a random heads-up hand for at most
60 fake seconds and asserted no time bank was ever activated. Both are wrong
for that tempo:

- 800 sampled hands took up to 90 fake seconds; about 4% ran past 60 s and the
  test failed with the hand still `dealing`.
- A "tank" with a usable bank legitimately runs into the bank
  (`lightningHorseThinkTimeMs`, the physical engine's mapping), which failed
  the `TIME_BANK_ACTIVATED === false` assertion on its own.

Looped locally, the original test failed 6 of 122 runs.

## Fix

The product is right; the test now pins the tempo it is about (the brain still
chooses every action and amount):

- "inside its deadline": every decision is a 4 s beat; the hand plays out
  under a budget no legitimate hand reaches (30 fake minutes, exits as soon as
  the hand completes); no bank activates, and every voluntary action has origin
  `horse_policy` (never the clock).
- New: "a horse that tanks runs into its bank, not out of its clock, and still
  acts": the first decision is the bank sentinel; the bank activates, stops on
  the horse's own action, never expires, and the clock folds nobody.

Both fail if the host stops scheduling horses (checked by mutation).
