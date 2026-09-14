# Horse Brain Phase14: fit each report model once

The journaled report consumer fitted each cohort/partition for its stored estimate, then fitted both partitions again inside its predictive diagnostic. Four distinct models therefore required eight fits and repeated the largest bounded allocations.

buildJournaledOpponentStudy now owns the two immutable fits per cohort and scores those exact models. The real report consumer uses that result directly. The superseded journal-only validation wrapper has no remaining caller and was removed. The complete-source holdout API, model algorithm, confidence bounds, session/hand weighting, source restrictions and activation refusal are unchanged.

The regression test observed eight fits before the repair and four afterward. It also binds each diagnostic model ID to the exact reported training/holdout model. The focused model/holdout/consumer suite passed65 tests and the server build passed. The final full server suite passed12422tests across822files, with146existing database-fixture cases in one file skipped.

Fixed local fixtures cover both cohorts and both partitions under a256MiB heap. A19000-row,16507809-byte population produced identical before/after report digest243e7ceabc6781ba0ae8bcfaec8b4b9079078c1018a23e5f09648bce79f8b7b9. A20000-row,10096666-byte population retained digestb8f7e65c3724ebac8037fcd41be4c8404596b4afe689fdedcbf734c1b1cae13d. Each run repeats three times and checks deterministic output. Median time fell from265.46ms to230.85ms and168.31ms to144.64ms respectively; peak RSS fell from218080KiB to210064KiB and205264KiB to197632KiB. These are isolated bounded diagnostic measurements, not fleet throughput or action-clock qualification.

No SQL or production data changed. Schema and RPC payload contracts are unchanged. Publication and natural model-report proof remain required. Source completeness, causal proposals and controlled activation/rollback remain open; a faster observational report does not establish them.
