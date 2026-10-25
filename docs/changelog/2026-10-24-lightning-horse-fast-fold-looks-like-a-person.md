# A Lightning horse's fast fold now takes a person's reaction time (2026-10-24)

Follow-up to #7958. When a horse was "already folding", it pressed Lightning
Fold the moment the decision lane answered, which took a few tens of
milliseconds. Over many hands every horse seat cleared at the deal faster and
more evenly than any person can. Watching players can spot that rhythm, and
CLAUDE.md 10.5 ("TIMING IS PART OF THE TREATMENT") forbids it. Dan approved
the fix on 2026-10-24 at 21:52 Chicago time: "GO AHEAD AND FULLY BUILD, FIX
AND ENHANCE ALL OF THESE".

## What changed

- `lightningHorseFastFoldReactionMs` (server/src/lightning/LightningHorse.ts)
  draws a new look-and-press time for each fold. The model is a shifted
  lognormal, the standard model for human choice reaction times: a 450 ms
  floor plus lognormal(median 600 ms x the horse's tempo, sigma 0.5), capped
  at 3000 ms. Across the population that gives p05 about 0.71 s, p50 about
  1.07 s, p95 about 1.9 s and p99 about 2.4 s. Each horse has its own fixed
  tempo between 0.8 and 1.25, taken from its id.
- The host's injected `random` dependency drives the draw (it also drives the
  think-time back-off), so tests are deterministic.
- An early look that answers "already folding" now stays open while the
  press is pending:
  - the fold goes through the same `fast_fold` door, and legality is checked
    again at the moment it lands;
  - if the horse's own turn arrives first, the turn takes over the look and
    keeps its start time and press time, so there is one fold, never two;
  - the street moving on, the hand ending, the account's own client taking
    the seat, or the operator's fast-fold switch going off all cancel it.
- An already-folding fold on the horse's own turn waits for the same press
  time instead of landing at once.

## Why it is not measured from production

On 2026-10-24 production held only 11 human Lightning fast folds, from 3
players, all on one day. On top of that, `folded_at - formed_at` includes
the roughly 1.8 s gap between forming the hand and dealing it, plus folds on
later streets. That is not a reaction-time sample. The reasoning behind the
chosen distribution is next to the constants. Re-measure it once there is
real human fast-fold volume.

## Also fixed

`LightningHandHost.test.ts` "a horse that tanks runs into its bank" failed
about a third of the time on main. If the brain's first answer was a fold,
that fold was already-folding, so the horse never tanked. The tanking
decision in that test is now pinned to a call or a check.
