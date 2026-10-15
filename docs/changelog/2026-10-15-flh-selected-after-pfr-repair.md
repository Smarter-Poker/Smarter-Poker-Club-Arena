# FLH Is Selected Again After The Opponent-Read Repair

## What Was Wrong

- #6777 repaired HorseMind's opponent reads (a raise after a call now counts as PFR; an all-in
  call is no longer counted as aggression). HorseMind is hashed by the Phase 12 policy digest, so
  FLH generation 2 (measured on 9d567463) was set to null and FLH played shadow on the repaired
  source.

## What Changed

- The locked FLH matrix under contract v1 was re-run on the exact repaired source
  c92768c85bc53a4a5a5972d09c6ee58561010035 (run 38656879989): 42 of 42 shards, 544,320 pairs,
  cash after rake against the horse population +1.11 [+0.70, +1.52] bb/100, qualified on
  condition (a) with no reasons, policy digest 67f964ba....
- The natural completion window was declared before it opened
  (`docs/evidence/phase12/declaration-completion-pfr-repair-2026-10-14.txt`, written
  2026-10-14T23:55:26Z). Release c92768c8 (StartedAt 2026-10-14T23:55:32Z) served unchanged
  across 2026-10-15T00:02:00.000Z to 00:50:00.000Z, read at 00:00:52Z and 00:50:50Z. FLH meets
  the 0.95 floor on every street (Wilson lower bounds: preflop 0.9932, flop 0.9865, turn
  0.9847, river 0.9807; 2,221 decisions).
- `PHASE12_PROTECTED_RELEASE_SELECTIONS.flh` names the new qualification and completion record
  at approval generation 3 (generation 2 stays retained and refused by digest). The
  qualification, its strength record and the completion record ship under
  `server/release-evidence/`.
- Short Deck, Crazy Pineapple and FLO8 stay null.

## Status

Implemented; natural accepted FLH use is read on the first serving release that contains this
selection. The same window's PLO5, PLO6 and PLO8 completion records all meet the floor and are
committed with their strength results once the Phase 11 matrices finish.
