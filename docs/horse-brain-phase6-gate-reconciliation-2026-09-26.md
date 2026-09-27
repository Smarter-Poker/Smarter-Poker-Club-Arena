# Horse Brain Phase 6: Gate Reconciliation Across 6A, 6B, 6C and 6D

Written 2026-09-27 against the Phase 6D declaration of 2026-09-26; the file names keep the
declaration date. Horse Brain only. Every cell carries exactly one status from the handoff
vocabulary (section 8 of `horse-brain-continuation-command.md`): verified now, historical
only, implemented but unverified, defective, unavailable external input, not applicable with
reason. Nothing here is averaged into a percentage, and no stage is declared complete.

## Sources Read

| Source                                                                                    | What it says at the time of writing                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CURRENT-DELIVERY.json` `phase6Build` (file time 2026-09-26T14:08:06Z, reread 2026-09-27) | `status` = `gates_1_3_passed_gate_4_pending_first_certificate_on_an_engine_with_5329_and_5340`; `readyFor6B` = false                                   |
| `DELIVERY-VERIFICATION.md`, section "The containing release sealed, September 25"         | gate 1 passed, gate 2 passed, gate 3 passed on 778075b4; gate 4 open                                                                                   |
| Engine `/health`, read over ssh 2026-09-27T14:26:11Z                                      | `releaseSha` f2e484a3d1a674f329d923b30394fd65f5aff50e; `horseJournal.mode` paused, `pausedReason` archive_segments, `pausedSince` 2026-09-26T14:13:54Z |
| `docs/evidence/phase6d/population-2026-09-26.json` and `.md`                              | predeclared population run 2026-09-27T14:44Z to 14:48Z, qualified execution true                                                                       |
| `git merge-base --is-ancestor`, run 2026-09-27                                            | f2e484a3 contains 563fac93 and f1059b99 (Phase 6A); it does not contain ee7f3a03 (#5329), bc0cde52 (#5340) or 9e275e1c (#5355)                         |

## Status Matrix

| Stage | G1                         | G2                         | G3                         | G4                         | G5                         | G6                         | G7                         | G8                         | G9                         | G10                        |
| ----- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- |
| 6A    | not applicable with reason | historical only            | not applicable with reason | verified now               | historical only            | historical only            | verified now               | not applicable with reason | not applicable with reason | implemented but unverified |
| 6B    | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified |
| 6C    | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified | implemented but unverified |
| 6D    | historical only            | historical only            | historical only            | verified now               | historical only            | historical only            | verified now               | implemented but unverified | not applicable with reason | defective                  |

## Phase 6A (1 of 4)

The four-gate record, as `CURRENT-DELIVERY.json` and `DELIVERY-VERIFICATION.md` state it:

| 6A gate                         | Record  | Evidence                                                                                                                   |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1 containing release            | passed  | 778075b4 sealed 2026-09-25, receipt `ca_engine_deploy_attempts` shipped=true, ancestry of 563fac93 and f1059b99            |
| 2 catalog custody               | passed  | `outputs/phase6a/catalog-custody-20260925T154725Z.json`, original 16-record segment 3f8211a4 indexed and no longer pending |
| 3 finite natural observation    | passed  | `outputs/phase6a/phase6a-natural-archive-20260925T203106554415Z.json`, 3 completed hands on 778075b4, status qualified     |
| 4 post-deployment certification | pending | `gates_1_3_passed_gate_4_pending_first_certificate_on_an_engine_with_5329_and_5340`                                        |

| Gate                       | Status                     | Evidence                                                                                                                                                                              |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | not applicable with reason | 6A owns context-to-receipt provenance; the atlas domain matrix is stage 6B (`docs/horse-brain-phase6-build-plan-2026-09-18.md`, 6A and 6B sections)                                   |
| G2 Inputs                  | historical only            | gate 3 cohort on 778075b4 verified request lifecycles and v2 context receipts; the serving f2e484a3 has written no journal record, so no current natural input receipt exists         |
| G3 Computation             | not applicable with reason | 6A adds no calculation; `HorsePhase6Attribution.ts` records the lookup actually performed; calculation qualification is 6B and 6C                                                     |
| G4 Immutable authority     | verified now               | `/health` 2026-09-27 serves f2e484a3, which contains 563fac93 and f1059b99; the 6D observer confirmed image eaa22515 carries that revision label before and after its read            |
| G5 Reachability            | historical only            | gate 3 cohort and 459 complete five-link chains in the 6D population, all produced by 778075b4; zero by the serving release                                                           |
| G6 Outcome receipts        | historical only            | the 6D population distinguishes atlas_evaluated 212, unavailable 215, bypassed 63 attribution receipts on 778075b4 (counts of chains, not rates)                                      |
| G7 Independent correctness | verified now               | rerun 2026-09-27 on this branch: `TournamentBrainContextCache.test.ts` 25, `TournamentBlindSnapshot.test.ts` 22, `HorsePhase6Tournament.test.ts` 43, all passed                       |
| G8 Performance and replay  | not applicable with reason | original-input replay and latency measurement are stage 6C by the build plan                                                                                                          |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate; Phases 7 to 15 are excluded from this stage                                                                                       |
| G10 Publication and use    | implemented but unverified | `CURRENT-DELIVERY.json` phase6Build.status `gates_1_3_passed_gate_4_pending_first_certificate_on_an_engine_with_5329_and_5340`; the serving f2e484a3 contains neither #5329 nor #5340 |

## Phase 6B (2 of 4)

Another lane is building 6B today. These rows are left for the coordinator; no status is
guessed from the earlier slice already on main.

| Gate                       | Status                     | Evidence                |
| -------------------------- | -------------------------- | ----------------------- |
| G1 Domain                  | implemented but unverified | pending PR from lane 6B |
| G2 Inputs                  | implemented but unverified | pending PR from lane 6B |
| G3 Computation             | implemented but unverified | pending PR from lane 6B |
| G4 Immutable authority     | implemented but unverified | pending PR from lane 6B |
| G5 Reachability            | implemented but unverified | pending PR from lane 6B |
| G6 Outcome receipts        | implemented but unverified | pending PR from lane 6B |
| G7 Independent correctness | implemented but unverified | pending PR from lane 6B |
| G8 Performance and replay  | implemented but unverified | pending PR from lane 6B |
| G9 Learning and promotion  | implemented but unverified | pending PR from lane 6B |
| G10 Publication and use    | implemented but unverified | pending PR from lane 6B |

## Phase 6C (3 of 4)

Another lane is building 6C today. These rows are left for the coordinator.

| Gate                       | Status                     | Evidence                |
| -------------------------- | -------------------------- | ----------------------- |
| G1 Domain                  | implemented but unverified | pending PR from lane 6C |
| G2 Inputs                  | implemented but unverified | pending PR from lane 6C |
| G3 Computation             | implemented but unverified | pending PR from lane 6C |
| G4 Immutable authority     | implemented but unverified | pending PR from lane 6C |
| G5 Reachability            | implemented but unverified | pending PR from lane 6C |
| G6 Outcome receipts        | implemented but unverified | pending PR from lane 6C |
| G7 Independent correctness | implemented but unverified | pending PR from lane 6C |
| G8 Performance and replay  | implemented but unverified | pending PR from lane 6C |
| G9 Learning and promotion  | implemented but unverified | pending PR from lane 6C |
| G10 Publication and use    | implemented but unverified | pending PR from lane 6C |

## Phase 6D (4 of 4)

| Gate                       | Status                     | Evidence                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | historical only            | 3969 declared cells; 193 observed (cash 20, mtt 173), 3776 unobserved; sng, spin and hu_sng 0 observed; branch open_facing and table size 10 never reached; all from 778075b4                                                                                                                                                 |
| G2 Inputs                  | historical only            | request link present on 490 of 490 admitted chains (lifecycle digest equals the decision snapshot digest), all on 778075b4                                                                                                                                                                                                    |
| G3 Computation             | historical only            | calculation link present on 490 of 490 (decision receipt, sampling state and compute metadata validated by the image's own validators)                                                                                                                                                                                        |
| G4 Immutable authority     | verified now               | declaration sha256 6274176c committed before any record was read; the selector refuses an edited or uncommitted declaration and any drifted rerun; observer image eaa22515 equals the serving identity before and after, 2026-09-27                                                                                           |
| G5 Reachability            | historical only            | 459 chains with all five links present (request, calculation, reference, accepted action, completed hand), all on 778075b4                                                                                                                                                                                                    |
| G6 Outcome receipts        | historical only            | 31 incomplete chains name their gap: missing:accepted_action:second_look_unchanged 13, missing:hand_binding:observation_identity_unavailable 18, missing:hand_binding:execution_unavailable 13 (the 13 retired turns carry both marks)                                                                                        |
| G7 Independent correctness | verified now               | `server/src/services/horseDecisionJournal/phase6dPopulation.test.ts`, 9 tests with explicit fixture predicates, passed 2026-09-27; the live link predicates are the image's validators, not an independent oracle                                                                                                             |
| G8 Performance and replay  | implemented but unverified | frozen population declared (24 hourly strata, 400 hands per stratum, target 3 per cell); latency and original-input replay depend on the pending PR from lane 6C                                                                                                                                                              |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate                                                                                                                                                                                                                                                                            |
| G10 Publication and use    | defective                  | the serving release f2e484a3 has zero natural receipts: journal archiving stopped at 2026-09-25T19:34:05Z with 500000 of 500000 segments and `/health.horseJournal` paused on archive_segments since 2026-09-26T14:13:54Z; the root fix #5355 (9e275e1c, the archive becomes a ring) is merged but not in the serving release |

## What The 6D Population Shows And Does Not Show

- The run is `node server/scripts/phase6d-population.mjs run --declaration docs/evidence/phase6d/population-declaration-2026-09-26.json --out docs/evidence/phase6d --date 2026-09-26`. It walked 2000 hands in strata 1 to 5; stratum 0 and strata 6 to 23 hold no archived records.
- Of 14141 decision records read, 6249 were postflop and fill no cell; 7892 preflop decisions were classified; 490 were admitted up to the target of 3 per cell; the rest are counted as overflow per cell.
- 7888 unarchived records sit in the legacy journal store, which is itself at its byte limit. The declared selection walks archived events only, so they are outside this population by declaration, not by choice after reading.
- Every admitted chain comes from 778075b4. It is production evidence for that release inside the window, not evidence for the serving revision.
- No cell is filled, estimated or inferred from a neighbour. Unobserved means unobserved.

## Remaining Dependencies

1. 6A gate 4: an exact-engine post-deployment certificate on an engine containing #5329 and #5340, as `CURRENT-DELIVERY.json` states.
2. 6D G10: a release containing #5355 so the journal archives again; then a new declaration, committed before any read, for a window on that serving release.
3. 6B and 6C rows: the coordinator replaces the pending pointers with the lanes' PR evidence.
4. Phase 7 and later are not certified by any of this.
