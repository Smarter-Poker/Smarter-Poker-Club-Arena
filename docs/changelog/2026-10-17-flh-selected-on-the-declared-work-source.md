# FLH Is Selected Again On The Declared-Work Source

- The fixed-limit hold'em strategy pack is switched on again for every horse at cash tables (generation 4). It had been
  off since the 2026-10-16 bundle (#7166) changed every pack's policy digest.
- Strength: the locked FLH v1 matrix on the exact source d9190c9e (run 38988196506, 42 of 42 shards, 544,320 pairs)
  beats the current brain after rake against the horse population by +1.11 bb/100, 99% interval [+0.70, +1.52],
  qualified with no reasons, at policy digest d3d1b293.
- Natural completion: the window predeclared in `docs/evidence/phase12/declaration-completion-requal-bundle-2026-10-17.txt`
  (2026-10-17 04:02 to 04:50Z on release 9ccf3e42, which carries d9190c9e's digests; identity read 04:00:30Z and
  04:50:29Z, unchanged) completed every eligible decision on every street: preflop 519, flop 316, turn 280, river 234;
  lowest Wilson bound 0.9724 (river).
- Tournaments keep the Phase 7 owner (shadow), as before. Short Deck, Pineapple and FLO8 stay off until their contract
  v2 matrices finish on the same source.
- Evidence ships byte-identical under `docs/evidence/phase12/d9190c9e/` and `server/release-evidence/`.
