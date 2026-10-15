# PLO8 Is Selected Again After The Opponent-Read Repair

## What Was Wrong

- #6777 repaired HorseMind's opponent reads, which the Phase 11 policy digest hashes, so PLO5,
  PLO6 and PLO8 generation 1 (measured on 1235b47a) were set to null and played shadow.

## What Changed

- The locked P11.2 PLO8 matrix was re-run on the exact repaired source
  c92768c85bc53a4a5a5972d09c6ee58561010035 (run 38656878018): 114 of 114 shards, 1,116,288 pairs,
  +7.84 [+6.84, +8.84] bb/100 cash after rake against the horse population, qualified with no
  reasons at policy digest a5daefa9....
- Natural completion on release c92768c8 in the predeclared window 2026-10-15 00:02 to 00:50Z
  (`docs/evidence/phase12/declaration-completion-pfr-repair-2026-10-14.txt`) meets the 0.95
  floor on every street: 5,254 decisions, Wilson lower bounds 0.998, 0.990, 0.990, 0.986.
- `PHASE11_PROTECTED_RELEASE_SELECTIONS.plo8` names both at approval generation 2; they and the
  strength record ship under `server/release-evidence/`. The Phase 11 selection tests now accept a
  pack that is either unselected or selected at generation 2 on the repaired source, so PLO5 and
  PLO6 join by changing only their selection entries once their matrices finish. Their
  completion records from the same window already meet the floor.

## Status

Implemented; natural accepted PLO8 use is read on the first serving release containing it.
