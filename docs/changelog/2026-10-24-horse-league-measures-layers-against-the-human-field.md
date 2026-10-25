# The horse league measures layers against the human field, not only against other horses

Every card on the nightly Horse League was a mirror: six horses, half on config A and half on config B, swapped between the two passes of a duplicate deal. That measures what a layer is worth against other horses. Live data says the fleet is roughly break-even against human players before rake, so the number that pays is what a layer earns against humans, and no card measured it.

## What changed

- `LeagueMatchup.opponentPopulation` (optional). Set to the human-calibrated population id (`human-calibrated-v1-20261008`, `HumanCalibratedPopulation.ts`), a card seats one hero horse in seat 1 and the calibrated population in every other seat. Those seats are human seats (`is_horse: false`, ids `league-human-N`), so HorseLogic never decides for them. Pass 1 of each duplicate pair seats arm A as the hero. Pass 2 replays the same deal, dealer and hero seat with arm B against the same field. The arms differ only in the flag under test, so card luck cancels in the difference. `bb100`/`stderr` are the hero's per-hand edge of arm A over arm B against the field. Each arm's own absolute bb/100 against the field goes in `benchmarkComponents` (`human_field_arm_a`, `human_field_arm_b`). The result also carries `opponentPopulation` and `humanResponses`, the field's response counts per decision node, as proof the field actually played.
- Kept unchanged: the per-pair seed and dealer rotation, one HorseMind sandbox per pass for the whole matchup, the save/restore bracket around the shared strategy RNG, the street engine, `validateAction` legalization for every seat (human seats included), side-pot settlement, the sandboxed settlement observation and the divergence/INERT count. Mirror cards follow exactly the old code path and return exactly the old result shape.
- Compute boundary: `isLeagueResult` accepts a third exact shape (measured + `opponentPopulation` + `humanResponses`). It refuses a wrong population id, unknown actions, negative counts, a field that never decided over dealt hands, anything other than the two per-arm components in order, and component hand counts that disagree. The client also refuses a result whose field does not match the requested card (a human card answered by a mirror result, or the reverse).
- Nightly runner: the cards go through the same worker lane. `config_a`/`config_b` record `opponentPopulation` for a human card (`leagueResultConfig`), and the names carry a `human_` prefix. No migration and no new column: the row's existing columns describe it completely, and mirror rows are written exactly as before.
- Card: seven human twins, derived from their mirror cards so the arms cannot drift. They are `human_mind_layer`, `human_v12_ranges_river`, `human_v7_preflop`, `human_v11_leak_fixes`, `human_v10_strategy`, `human_v20_multiway` and `human_full_vs_v2_legacy`, each at 12,000 pairs.

## How the cards were chosen

A divergence probe against the field (3,000 pairs, seed 20261024) counted the pairs whose two passes settled differently. Results: full_vs_v2_legacy 500, mind_layer 283, v7_preflop 282, v12_ranges_river 185, v11_leak_fixes 50, v10_strategy 47, v20_multiway 8, v19_size_reads 11, v21_river_endgame 10, v16_sizecond 9, v51_river_flat 4, v16_deep_reads 3, v52_range_advantage 2, v23_raise_plans 1, and 0 for v23_river_reads, v18_squeeze_response and v18_exploit_size. The highest-divergence layers became twins, plus v20_multiway, which was on the requested list and diverges, if rarely. v51_river_flat and v52_range_advantage were on the requested list too, but against this field they change about one hand in a thousand, so a nightly row would be noise or INERT. They stay mirror-only until a re-probe says otherwise.

## Cost

A human-field pair asks HorseLogic for one seat instead of six. It measured about 6 ms per pair against about 19 ms for a mirror pair on the same box. So a 12,000-pair twin costs about what one default 4,000-pair mirror matchup does, and its stderr is about half the 3,000-pair probe's. The nightly budget does not change: a run is still bounded by its windows and `MAX_RUN_MS`. Staleness-first ordering runs the never-measured twins first, after which they rotate with the rest of the card.

## Limitations, stated plainly

- NLH only (`HUMAN_FIELD_VARIANTS`). The population has an Omaha profile, but `docs/horse-brain-human-population-2026-10-08.md` records it as missing the 5-point fidelity criterion at the flop facing-bet node (5.6 points). The "other" profile rests on 85 human seat-hands. A human card in any other variant is refused; no profile was invented.
- Every family, NLH included, is below the winning contract's calibration minimums (5 distinct humans, 1,718 NLH seat-hands). A human-field row is a development measurement of a layer against human tendencies. It is not a qualification and not a promotion gate.
- Rake is not modelled, the same as on the mirror cards.

Pinned by `server/src/benchmark/HorseLeagueHumanField.test.ts`.
