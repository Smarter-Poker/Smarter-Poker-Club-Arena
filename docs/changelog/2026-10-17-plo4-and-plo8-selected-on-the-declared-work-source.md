# PLO4 And PLO8 Are Selected Again On The Declared-Work Source

- The PLO4 pack (Phase 10, generation 3) and the PLO8 pack (Phase 11, generation 3) are switched on again for every
  horse at cash tables. They had been off since the 2026-10-16 bundle (#7166) changed every pack's policy digest.
- PLO4: the locked P10.2 matrix on the exact source d9190c9e (run 38988202259, 100 of 100 shards, 2,557,440 pairs)
  beats the current brain after rake against the horse population by +6.93 bb/100, 99% interval [+6.25, +7.62],
  qualified with no reasons, at policy digest 99028825. Phase 10 has no completion stage of its own (#6901 precedent).
- PLO8: the locked P11.2 matrix on d9190c9e (run 38988208052, 114 of 114 shards, 1,116,288 pairs): +7.82 bb/100,
  99% interval [+6.82, +8.82], no reasons, at policy digest d4f5111a. Natural completion in the window predeclared in
  `docs/evidence/phase12/declaration-completion-requal-bundle-2026-10-17.txt` (2026-10-17 04:02 to 04:50Z on release
  9ccf3e42): every eligible decision completed on every street (preflop 1,730, flop 681, turn 486, river 324; lowest
  Wilson bound 0.9799).
- Tournaments keep the Phase 7 owner (shadow). PLO5 and PLO6 stay off until their matrices finish on the same source.
- Evidence ships byte-identical under `docs/evidence/phase1{0,1}/d9190c9e/` and `server/release-evidence/`.
