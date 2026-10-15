# PLO5 And PLO6 Are Selected Again After The Opponent-Read Repair

- The locked P11.2 matrices were re-run on the exact repaired source
  c92768c85bc53a4a5a5972d09c6ee58561010035 (#6777). PLO5: run 38656874186, 243 of 243 shards,
  2,379,456 pairs, +5.37 [+4.25, +6.49] bb/100. PLO6: run 38656876020, 2,519,424 pairs, +3.68
  [+2.89, +4.47] bb/100. Both are cash after rake against the horse population and qualified
  with no reasons. Shards cancelled to free shared runners for engine releases were re-run;
  every cancelled attempt is recorded in the strength record and never counted.
- Natural completion on release c92768c8 in the predeclared window 2026-10-15 00:02 to 00:50Z
  meets the 0.95 floor on every street: PLO5 18,183 decisions (Wilson lower bounds 0.999, 0.994,
  0.992, 0.993), PLO6 12,262 decisions (0.998, 0.993, 0.989, 0.991).
- `PHASE11_PROTECTED_RELEASE_SELECTIONS.plo5` and `.plo6` name them at approval generation 2;
  the files ship under `server/release-evidence/`. With PLO8 (#6917), every Phase 11 pack is
  selected again.
