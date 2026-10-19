# FLH generation 5 is selected on the VPIP-floor source (2026-10-19)

The VPIP floor call-down (#7323) moved every hashed Horse policy digest, so every
pack was unselected until it requalified. Fixed Limit Hold'em is the first back.

- Strength: the locked FLH v1 matrix (run 39132882188, 42 of 42 shards) on source
  da94e437 qualified with no reasons: cash after rake against the horse population
  +1.11 [+0.70, +1.52] bb/100 over 544,320 pairs, policy digest ff32377e...
  Evidence: `docs/evidence/phase12/da94e437/`.
- Completion: the prospective window under
  `docs/evidence/phase13/declaration-completion-vpip-2026-10-18-addendum-1.txt`,
  opened 2026-10-18 23:00:10Z on release 6e3ab4f3 (all 17 digests equal to da94),
  collected 23:02 to 23:50Z, closed valid on the same container. Every eligible
  FLH betting decision completed on every street (preflop 916, flop 522, turn 457,
  river 337; lowest 99% Wilson bound 0.9807).
- Selection: `PHASE12_PROTECTED_RELEASE_SELECTIONS.flh`, approval generation 5, cash
  only. The tournament objective remains an unavailable dependency. Short Deck,
  Crazy Pineapple and FLO8 stay null until their own matrices finish.
- Evidence ships byte-identically under `server/release-evidence/`.
